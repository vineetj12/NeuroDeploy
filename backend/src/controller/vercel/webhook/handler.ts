import type { Request, Response } from "express";
import { enqueueFixProject } from "../../../queue/fixProjectQueue.ts";
import { fetchProjectById, fetchProjects } from "../vercel.ts";
import type { VercelProject } from "../../../types.ts";
import {
  asRecord,
  extractDeploymentId,
  extractDeploymentTarget,
  extractGitHubRef,
  extractGitHubRepoFullName,
  extractGitHubSha,
  extractProjectId,
  extractReadyState,
  getLatestDeployment,
  getProductionBranch,
  hasErrorSignal,
  isMainBranch,
  normalizeBranchName,
  type AnyRecord,
} from "./extractors.ts";
import { monitorDeploymentUntilFinal } from "./monitor.ts";

// ── Internal helpers ────────────────────────────────────────────────────────

async function resolveProjectByRepoFullName(
  repoFullName: string
): Promise<VercelProject | null> {
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

// ── GitHub push webhook ─────────────────────────────────────────────────────

async function handleGitHubWebhook(payload: AnyRecord, res: Response): Promise<void> {
  const branch = normalizeBranchName(extractGitHubRef(payload));
  if (!isMainBranch(branch)) {
    res.status(202).json({ ok: true, ignored: true, branch, message: "Ignoring non-main branch push" });
    return;
  }

  const repoFullName = extractGitHubRepoFullName(payload);
  if (!repoFullName) {
    res.status(202).json({ ok: true, ignored: true, branch, message: "Main branch push received but repository information is missing" });
    return;
  }

  const commitSha = extractGitHubSha(payload);
  const project = await resolveProjectByRepoFullName(repoFullName);
  if (!project) {
    res.status(202).json({ ok: true, ignored: true, repoFullName, branch, commitSha, message: "No Vercel project matched this GitHub repository" });
    return;
  }

  const productionBranch = getProductionBranch(project);
  if (!isMainBranch(productionBranch)) {
    res.status(202).json({ ok: true, ignored: true, projectId: project.id, repoFullName, branch, productionBranch, message: "Project is not configured to use main as production branch" });
    return;
  }

  const latestDeployment = getLatestDeployment(project, null);
  if (!latestDeployment?.id) {
    void monitorDeploymentUntilFinal(project.id, null, `github:${repoFullName}:${commitSha ?? "<no-sha>"}`);
    res.status(202).json({ ok: true, queued: false, projectId: project.id, repoFullName, branch, commitSha, message: "Main branch push received. Waiting for the first Vercel deployment to appear." });
    return;
  }

  const readyState = latestDeployment.readyState ?? null;

  if (readyState === "READY") {
    res.status(200).json({ ok: true, queued: false, projectId: project.id, deploymentId: latestDeployment.id, repoFullName, branch, commitSha, message: "Deployment is already ready. No action needed." });
    return;
  }

  if (readyState === "ERROR") {
    const jobId = await enqueueFixProject({ projectId: project.id, latestDeploymentId: latestDeployment.id! });
    res.status(202).json({ ok: true, queued: true, jobId, projectId: project.id, deploymentId: latestDeployment.id, repoFullName, branch, commitSha });
    return;
  }

  void monitorDeploymentUntilFinal(project.id, latestDeployment.id ?? null, `github:${repoFullName}:${commitSha ?? "<no-sha>"}`);
  res.status(202).json({ ok: true, queued: false, projectId: project.id, deploymentId: latestDeployment.id, repoFullName, branch, commitSha, readyState, message: "Main branch push received. Waiting for Vercel to finish deploying before taking action." });
}

// ── Vercel deployment webhook ───────────────────────────────────────────────

async function handleVercelDeploymentWebhook(payload: AnyRecord, res: Response): Promise<void> {
  const projectId = extractProjectId(payload);
  const deploymentId = extractDeploymentId(payload);
  const readyState = extractReadyState(payload);
  const target = extractDeploymentTarget(payload);

  if (!projectId) {
    res.status(202).json({ ok: true, ignored: true, reason: "Missing projectId in webhook payload" });
    return;
  }

  const project = await fetchProjectById(projectId);
  const productionBranch = getProductionBranch(project);

  if (!isMainBranch(productionBranch)) {
    res.status(202).json({ ok: true, ignored: true, projectId, productionBranch, reason: "Ignoring project because production branch is not main" });
    return;
  }

  if (target && target !== "production") {
    res.status(202).json({ ok: true, ignored: true, projectId, deploymentId, target, reason: "Ignoring non-production deployment event" });
    return;
  }

  if (readyState === "READY") {
    res.status(200).json({ ok: true, queued: false, projectId, deploymentId, message: "Deployment finished successfully. No action needed." });
    return;
  }

  if (readyState === "ERROR") {
    if (!deploymentId) {
      res.status(202).json({ ok: true, queued: false, projectId, reason: "Deployment error received but deploymentId is missing" });
      return;
    }

    const jobId = await enqueueFixProject({ projectId, latestDeploymentId: deploymentId });
    res.status(202).json({ ok: true, queued: true, jobId, projectId, deploymentId });
    return;
  }

  if (deploymentId) {
    void monitorDeploymentUntilFinal(projectId, deploymentId, `vercel:${projectId}`);
  }

  res.status(202).json({ ok: true, queued: false, projectId, deploymentId, readyState, message: "Deployment is still in progress. Waiting for the final Vercel status." });
}

// ── Public entry point ──────────────────────────────────────────────────────

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

  if (
    extractProjectId(payload) ||
    hasErrorSignal(payload) ||
    extractReadyState(payload) ||
    extractDeploymentTarget(payload)
  ) {
    await handleVercelDeploymentWebhook(payload, res);
    return;
  }

  res.status(202).json({ ok: true, ignored: true, message: "Webhook payload does not match GitHub push or Vercel deployment event shapes" });
}
