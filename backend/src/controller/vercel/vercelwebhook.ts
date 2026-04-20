import type { Request, Response } from "express";
import { enqueueFixProject } from "../../queue/fixProjectQueue.ts";
import { fetchProjectById, fetchProjects } from "./vercel.js";
import type { VercelProject } from "../../types.ts";

type AnyRecord = Record<string, unknown>;

const ACTIVE_MONITORS = new Set<string>();
const MAX_MONITOR_ATTEMPTS = 30;
const MONITOR_DELAY_MS = 10_000;

function asRecord(value: unknown): AnyRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as AnyRecord;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function normalizeBranchName(ref: string | null): string | null {
	if (!ref) {
		return null;
	}

	if (ref.startsWith("refs/heads/")) {
		return ref.slice("refs/heads/".length);
	}

	return ref;
}

function isMainBranch(branch: string | null): boolean {
	return branch === "main";
}

function getProductionBranch(project: VercelProject): string {
	return project.link?.productionBranch || "main";
}

function extractProjectId(payload: AnyRecord): string | null {
	const directProjectId = asString(payload.projectId);
	if (directProjectId) {
		return directProjectId;
	}

	const project = asRecord(payload.project);
	const nestedProjectId = project ? asString(project.id) : null;
	if (nestedProjectId) {
		return nestedProjectId;
	}

	const deployment = asRecord(payload.deployment);
	const deploymentProjectId = deployment ? asString(deployment.projectId) : null;
	if (deploymentProjectId) {
		return deploymentProjectId;
	}

	return null;
}

function extractDeploymentId(payload: AnyRecord): string | null {
	const directDeploymentId = asString(payload.deploymentId);
	if (directDeploymentId) {
		return directDeploymentId;
	}

	const deployment = asRecord(payload.deployment);
	const nestedDeploymentId = deployment ? asString(deployment.id) : null;
	if (nestedDeploymentId) {
		return nestedDeploymentId;
	}

	const deploymentId = asString(payload.id);
	if (deploymentId) {
		return deploymentId;
	}

	return null;
}

function extractReadyState(payload: AnyRecord): string | null {
	const directReadyState = asString(payload.readyState);
	if (directReadyState) {
		return directReadyState;
	}

	const deployment = asRecord(payload.deployment);
	const nestedReadyState = deployment ? asString(deployment.readyState) : null;
	if (nestedReadyState) {
		return nestedReadyState;
	}

	return null;
}

function extractDeploymentTarget(payload: AnyRecord): string | null {
	const directTarget = asString(payload.target);
	if (directTarget) {
		return directTarget;
	}

	const deployment = asRecord(payload.deployment);
	const nestedTarget = deployment ? asString(deployment.target) : null;
	if (nestedTarget) {
		return nestedTarget;
	}

	return null;
}

function extractGitHubRef(payload: AnyRecord): string | null {
	return asString(payload.ref);
}

function extractGitHubRepoFullName(payload: AnyRecord): string | null {
	const repository = asRecord(payload.repository);
	if (!repository) {
		return null;
	}

	const fullName = asString(repository.full_name);
	if (fullName) {
		return fullName.toLowerCase();
	}

	const owner = asRecord(repository.owner);
	const ownerLogin = owner ? asString(owner.login) : null;
	const repoName = asString(repository.name);
	if (ownerLogin && repoName) {
		return `${ownerLogin.toLowerCase()}/${repoName.toLowerCase()}`;
	}

	return null;
}

function extractGitHubSha(payload: AnyRecord): string | null {
	const directSha = asString(payload.after);
	if (directSha) {
		return directSha;
	}

	const headCommit = asRecord(payload.head_commit);
	return headCommit ? asString(headCommit.id) : null;
}

function hasErrorSignal(payload: AnyRecord): boolean {
	const readyState = extractReadyState(payload);
	if (readyState && readyState.toUpperCase() === "ERROR") {
		return true;
	}

	const eventType = asString(payload.type);
	if (eventType && /error|failed|failure/i.test(eventType)) {
		return true;
	}

	return false;
}

function isFinalReadyState(readyState: string | null): boolean {
	return readyState === "READY" || readyState === "ERROR";
}

async function resolveProjectByRepoFullName(repoFullName: string): Promise<VercelProject | null> {
	const projects = await fetchProjects();

	for (const summary of projects) {
		try {
			const project = await fetchProjectById(summary.id);
			const projectRepo = project.link?.repo?.toLowerCase();
			const projectOrg = project.link?.org?.toLowerCase();

			if (projectRepo && projectOrg && `${projectOrg}/${projectRepo}` === repoFullName) {
				return project;
			}
		} catch (error) {
			console.error(`[webhook] failed to inspect project ${summary.id}:`, error);
		}
	}

	return null;
}

function getLatestDeployment(project: VercelProject, deploymentId: string | null): { id?: string; readyState?: string } | null {
	if (deploymentId) {
		const matched = project.latestDeployments?.find((deployment) => deployment.id === deploymentId);
		if (matched) {
			return matched;
		}
	}

	return project.latestDeployments?.[0] ?? null;
}

async function monitorDeploymentUntilFinal(projectId: string, deploymentId: string | null, context: string): Promise<void> {
	const monitorKey = `${projectId}:${deploymentId ?? "latest"}`;
	if (ACTIVE_MONITORS.has(monitorKey)) {
		return;
	}

	ACTIVE_MONITORS.add(monitorKey);

	try {
		for (let attempt = 1; attempt <= MAX_MONITOR_ATTEMPTS; attempt += 1) {
			const project = await fetchProjectById(projectId);
			const deployment = getLatestDeployment(project, deploymentId);
			const readyState = deployment?.readyState ?? null;

			console.log(
				`[webhook] monitor ${context} project=${projectId} deployment=${deployment?.id ?? deploymentId ?? "<none>"} attempt=${attempt} readyState=${readyState ?? "<unknown>"}`
			);

			if (readyState === "READY") {
				return;
			}

			if (readyState === "ERROR") {
				if (deployment?.id) {
					await enqueueFixProject({
						projectId,
						latestDeploymentId: deployment.id,
					});
				}
				return;
			}

			if (attempt < MAX_MONITOR_ATTEMPTS) {
				await sleep(MONITOR_DELAY_MS);
			}
		}
	} catch (error) {
		console.error(`[webhook] monitor failed for ${monitorKey}:`, error);
	} finally {
		ACTIVE_MONITORS.delete(monitorKey);
	}
}

async function handleGitHubWebhook(payload: AnyRecord, res: Response): Promise<void> {
	const branch = normalizeBranchName(extractGitHubRef(payload));
	if (!isMainBranch(branch)) {
		res.status(202).json({
			ok: true,
			ignored: true,
			branch,
			message: "Ignoring non-main branch push",
		});
		return;
	}

	const repoFullName = extractGitHubRepoFullName(payload);
	if (!repoFullName) {
		res.status(202).json({
			ok: true,
			ignored: true,
			branch,
			message: "Main branch push received but repository information is missing",
		});
		return;
	}

	const commitSha = extractGitHubSha(payload);
	const project = await resolveProjectByRepoFullName(repoFullName);
	if (!project) {
		res.status(202).json({
			ok: true,
			ignored: true,
			repoFullName,
			branch,
			commitSha,
			message: "No Vercel project matched this GitHub repository",
		});
		return;
	}

	const productionBranch = getProductionBranch(project);
	if (!isMainBranch(productionBranch)) {
		res.status(202).json({
			ok: true,
			ignored: true,
			projectId: project.id,
			repoFullName,
			branch,
			productionBranch,
			message: "Project is not configured to use main as production branch",
		});
		return;
	}

	const latestDeployment = getLatestDeployment(project, null);
	if (!latestDeployment?.id) {
		void monitorDeploymentUntilFinal(project.id, null, `github:${repoFullName}:${commitSha ?? "<no-sha>"}`);
		res.status(202).json({
			ok: true,
			queued: false,
			projectId: project.id,
			repoFullName,
			branch,
			commitSha,
			message: "Main branch push received. Waiting for the first Vercel deployment to appear.",
		});
		return;
	}

	const readyState = latestDeployment.readyState ?? null;
	if (readyState === "READY") {
		res.status(200).json({
			ok: true,
			queued: false,
			projectId: project.id,
			deploymentId: latestDeployment.id,
			repoFullName,
			branch,
			commitSha,
			message: "Deployment is already ready. No action needed.",
		});
		return;
	}

	if (readyState === "ERROR") {
		const jobId = await enqueueFixProject({
			projectId: project.id,
			latestDeploymentId: latestDeployment.id!,
		});

		res.status(202).json({
			ok: true,
			queued: true,
			jobId,
			projectId: project.id,
			deploymentId: latestDeployment.id,
			repoFullName,
			branch,
			commitSha,
		});
		return;
	}

	void monitorDeploymentUntilFinal(project.id, latestDeployment.id ?? null, `github:${repoFullName}:${commitSha ?? "<no-sha>"}`);
	res.status(202).json({
		ok: true,
		queued: false,
		projectId: project.id,
		deploymentId: latestDeployment.id,
		repoFullName,
		branch,
		commitSha,
		readyState,
		message: "Main branch push received. Waiting for Vercel to finish deploying before taking action.",
	});
}

async function handleVercelDeploymentWebhook(payload: AnyRecord, res: Response): Promise<void> {
	const projectId = extractProjectId(payload);
	const deploymentId = extractDeploymentId(payload);
	const readyState = extractReadyState(payload);
	const target = extractDeploymentTarget(payload);

	if (!projectId) {
		res.status(202).json({
			ok: true,
			ignored: true,
			reason: "Missing projectId in webhook payload",
		});
		return;
	}

	const project = await fetchProjectById(projectId);
	const productionBranch = getProductionBranch(project);

	if (!isMainBranch(productionBranch)) {
		res.status(202).json({
			ok: true,
			ignored: true,
			projectId,
			productionBranch,
			reason: "Ignoring project because production branch is not main",
		});
		return;
	}

	if (target && target !== "production") {
		res.status(202).json({
			ok: true,
			ignored: true,
			projectId,
			deploymentId,
			target,
			reason: "Ignoring non-production deployment event",
		});
		return;
	}

	if (readyState === "READY") {
		res.status(200).json({
			ok: true,
			queued: false,
			projectId,
			deploymentId,
			message: "Deployment finished successfully. No action needed.",
		});
		return;
	}

	if (readyState === "ERROR") {
		if (!deploymentId) {
			res.status(202).json({
				ok: true,
				queued: false,
				projectId,
				reason: "Deployment error received but deploymentId is missing",
			});
			return;
		}

		const jobId = await enqueueFixProject({
			projectId,
			latestDeploymentId: deploymentId,
		});

		res.status(202).json({
			ok: true,
			queued: true,
			jobId,
			projectId,
			deploymentId,
		});
		return;
	}

	if (deploymentId) {
		void monitorDeploymentUntilFinal(projectId, deploymentId, `vercel:${projectId}`);
	}

	res.status(202).json({
		ok: true,
		queued: false,
		projectId,
		deploymentId,
		readyState,
		message: "Deployment is still in progress. Waiting for the final Vercel status.",
	});
}

export async function handleVercelWebhook(req: Request, res: Response): Promise<void> {
	const payload = asRecord(req.body);
	if (!payload) {
		res.status(400).json({ ok: false, error: "Invalid JSON payload" });
		return;
	}

	if (extractGitHubRef(payload) || extractGitHubRepoFullName(payload)) {
		await handleGitHubWebhook(payload, res);
		return;
	}

	if (extractProjectId(payload) || hasErrorSignal(payload) || extractReadyState(payload) || extractDeploymentTarget(payload)) {
		await handleVercelDeploymentWebhook(payload, res);
		return;
	}

	res.status(202).json({
		ok: true,
		ignored: true,
		message: "Webhook payload does not match GitHub push or Vercel deployment event shapes",
	});
}