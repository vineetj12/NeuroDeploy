import axios from "axios";
import { simpleGit } from "simple-git";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VercelProject } from "../../types.ts";
import { runShellCommand } from "../../lib/shell.ts";

export async function cloneProjectRepository(
  jobId: string,
  project: VercelProject,
  githubToken: string
): Promise<{ repoDir: string; branch: string }> {
  const org = project.link?.org;
  const repo = project.link?.repo;
  const branch = project.link?.productionBranch || "main";

  if (!org || !repo) {
    throw new Error("Project link metadata is missing org/repo, cannot clone repository.");
  }
  if (!githubToken || githubToken.trim() === "") {
    throw new Error("GitHub token is missing for this user.");
  }

  const repoDir = join(tmpdir(), `neurodeploy-fix-${jobId}-${Date.now()}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${org}/${repo}.git`;

  const git = simpleGit();
  await git.clone(cloneUrl, repoDir, ["--branch", branch, "--single-branch"]);

  return { repoDir, branch };
}

/**
 * Creates and switches to a new local branch inside the cloned repository.
 */
export async function checkoutBranch(repoDir: string, branchName: string): Promise<void> {
  const git = simpleGit(repoDir);
  await git.checkoutLocalBranch(branchName);
}

export async function pushIfChanged(
  repoDir: string,
  branch: string,
  message: string
): Promise<boolean> {
  const git = simpleGit(repoDir);
  const status = await git.status();
  if (status.files.length === 0) return false;

  // Ensure git identity is set in the cloned repo (robust in container environments)
  try {
    await runShellCommand(`git config user.email "neurodeploy-bot@users.noreply.github.com"`, repoDir);
    await runShellCommand(`git config user.name "NeuroDeploy Bot"`, repoDir);
  } catch (err) {
    console.warn(`[pushIfChanged] Failed to set git config via shell: ${err}`);
  }

  await git.add(["."]);
  await git.commit(message);
  await git.push("origin", branch);
  return true;
}

export function buildFixBranchName(projectId: string, jobId: string): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9-_]/g, "-");
  return `neurodeploy/fix-${safeProjectId}-${jobId}-${Date.now()}`;
}

export function buildProfessionalCommitMessage(input: {
  projectName: string;
  candidate?: string;
  summary?: string;
}): string {
  const fallback = `fix(deploy): resolve deployment failure for ${input.projectName}`;
  const raw =
    (input.candidate && input.candidate.trim()) ||
    (input.summary && input.summary.trim()) ||
    fallback;

  let normalized = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");

  if (!normalized) normalized = fallback;

  const conventionalPattern =
    /^(feat|fix|chore|docs|refactor|perf|test|build|ci|revert)(\([^)]+\))?:\s.+/i;
  if (!conventionalPattern.test(normalized)) {
    const lowerFirst = normalized.charAt(0).toLowerCase() + normalized.slice(1);
    normalized = `fix(deploy): ${lowerFirst}`;
  }

  if (normalized.length > 90) {
    normalized = `${normalized.slice(0, 87).trimEnd()}...`;
  }

  return normalized;
}

export async function createPullRequest(input: {
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  githubToken: string;
  title: string;
  body: string;
}): Promise<string | null> {
  if (!input.githubToken || input.githubToken.trim() === "") {
    throw new Error("GitHub token is missing for this user.");
  }

  try {
    const response = await axios.post(
      `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: false,
      },
      {
        headers: {
          Authorization: `Bearer ${input.githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    return response.data?.html_url ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message =
        (error.response?.data as { message?: string } | undefined)?.message ||
        error.message ||
        "Unknown GitHub PR error";
      throw new Error(`Failed to create pull request: ${message}`);
    }
    throw error;
  }
}
