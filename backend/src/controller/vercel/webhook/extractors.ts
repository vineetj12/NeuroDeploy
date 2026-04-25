import type { VercelProject } from "../../../types.ts";

export type AnyRecord = Record<string, unknown>;

// ── Primitive guards ────────────────────────────────────────────────────────

export function asRecord(value: unknown): AnyRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as AnyRecord;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// ── Payload field extractors ────────────────────────────────────────────────

export function extractProjectId(payload: AnyRecord): string | null {
  const directProjectId = asString(payload.projectId);
  if (directProjectId) return directProjectId;

  const project = asRecord(payload.project);
  const nestedProjectId = project ? asString(project.id) : null;
  if (nestedProjectId) return nestedProjectId;

  const deployment = asRecord(payload.deployment);
  const deploymentProjectId = deployment ? asString(deployment.projectId) : null;
  return deploymentProjectId ?? null;
}

export function extractDeploymentId(payload: AnyRecord): string | null {
  const directDeploymentId = asString(payload.deploymentId);
  if (directDeploymentId) return directDeploymentId;

  const deployment = asRecord(payload.deployment);
  const nestedDeploymentId = deployment ? asString(deployment.id) : null;
  if (nestedDeploymentId) return nestedDeploymentId;

  return asString(payload.id) ?? null;
}

export function extractReadyState(payload: AnyRecord): string | null {
  const directReadyState = asString(payload.readyState);
  if (directReadyState) return directReadyState;

  const deployment = asRecord(payload.deployment);
  return deployment ? asString(deployment.readyState) : null;
}

export function extractDeploymentTarget(payload: AnyRecord): string | null {
  const directTarget = asString(payload.target);
  if (directTarget) return directTarget;

  const deployment = asRecord(payload.deployment);
  return deployment ? asString(deployment.target) : null;
}

export function extractGitHubRef(payload: AnyRecord): string | null {
  return asString(payload.ref);
}

export function extractGitHubRepoFullName(payload: AnyRecord): string | null {
  const repository = asRecord(payload.repository);
  if (!repository) return null;

  const fullName = asString(repository.full_name);
  if (fullName) return fullName.toLowerCase();

  const owner = asRecord(repository.owner);
  const ownerLogin = owner ? asString(owner.login) : null;
  const repoName = asString(repository.name);
  if (ownerLogin && repoName) {
    return `${ownerLogin.toLowerCase()}/${repoName.toLowerCase()}`;
  }

  return null;
}

export function extractGitHubSha(payload: AnyRecord): string | null {
  const directSha = asString(payload.after);
  if (directSha) return directSha;

  const headCommit = asRecord(payload.head_commit);
  return headCommit ? asString(headCommit.id) : null;
}

// ── State helpers ───────────────────────────────────────────────────────────

export function hasErrorSignal(payload: AnyRecord): boolean {
  const readyState = extractReadyState(payload);
  if (readyState && readyState.toUpperCase() === "ERROR") return true;

  const eventType = asString(payload.type);
  return !!(eventType && /error|failed|failure/i.test(eventType));
}

export function isFinalReadyState(readyState: string | null): boolean {
  return readyState === "READY" || readyState === "ERROR";
}

// ── Branch helpers ──────────────────────────────────────────────────────────

export function normalizeBranchName(ref: string | null): string | null {
  if (!ref) return null;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref;
}

export function isMainBranch(branch: string | null): boolean {
  return branch === "main";
}

export function getProductionBranch(project: VercelProject): string {
  return project.link?.productionBranch || "main";
}

export function getLatestDeployment(
  project: VercelProject,
  deploymentId: string | null
): { id?: string; readyState?: string } | null {
  if (deploymentId) {
    const matched = project.latestDeployments?.find((d) => d.id === deploymentId);
    if (matched) return matched;
  }
  return project.latestDeployments?.[0] ?? null;
}
