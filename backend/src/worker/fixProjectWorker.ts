import { Worker } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { rm } from "node:fs/promises";
import { REDIS_URL } from "../envdata/data.ts";
import { fetchProjectById } from "../controller/vercel/vercel.ts";
import { FIX_PROJECT_QUEUE_NAME, type FixProjectJobData } from "../queue/fixProjectQueue.ts";
import { loadWorkerRuntimeCredentials } from "./lib/credentials.ts";
import { fetchDeploymentError } from "./lib/vercel.ts";
import {
  cloneProjectRepository,
  pushIfChanged,
  buildFixBranchName,
  buildProfessionalCommitMessage,
  createPullRequest,
  checkoutBranch,
} from "./lib/git.ts";
import { buildRepositorySnapshot, applyGeminiChanges } from "./lib/repo.ts";
import { validateWithDocker } from "./lib/docker.ts";
import { askSelectedModelForFix } from "./lib/ai.ts";

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 10000,
  retryStrategy: (times: number) => Math.min(2000 * times, 30000),
};

if (REDIS_URL.startsWith("rediss://")) {
  redisOptions.tls = {};
}

const connection = new Redis(REDIS_URL, redisOptions);

process.on("uncaughtException", (err) => {
  console.error("[fixProjectWorker] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fixProjectWorker] unhandledRejection:", reason);
});

function logStep(jobId: string, step: string): void {
  console.log(`[fixProjectWorker][job=${jobId}] ${step}`);
}

const worker = new Worker<FixProjectJobData>(
  FIX_PROJECT_QUEUE_NAME,
  async (job) => {
    const { projectId, latestDeploymentId, userId } = job.data;
    const jobId = String(job.id ?? "unknown");
    logStep(jobId, "Starting auto-fix workflow");

    if (!userId || userId.trim() === "") {
      logStep(jobId, "Skipping job because userId is missing (required for DB-backed credentials).");
      return;
    }

    const runtime = await loadWorkerRuntimeCredentials(userId);
    const project = await fetchProjectById(projectId, runtime.vercelToken);
    const buildCommand = project.buildCommand ?? null;

    let deploymentError = latestDeploymentId
      ? await fetchDeploymentError(latestDeploymentId, runtime.vercelToken)
      : "No deployment id provided.";

    logStep(jobId, `deploymentError=${deploymentError ?? "<none>"}`);

    // ── Step 1: Error Detected ───────────────────────────────────────────────
    await job.updateProgress({
      step: "error_detected",
      logs: [`[NeuroDeploy] Deployment failure detected for project "${project.name}".`, deploymentError ?? "No error message."],
      diff: null,
      prUrl: null,
    });

    if (!deploymentError) {
      await job.updateProgress({
        step: "no_error",
        logs: ["No deployment error detected. Nothing to fix."],
        diff: null,
        prUrl: null,
      });
      return;
    }

    let repoDir = "";
    let branch = "main";
    let featureBranch = "";
    let lastDiff: string | null = null;

    try {
      // ── Step 2: AI Analyzing ─────────────────────────────────────────────
      await job.updateProgress({
        step: "ai_analyzing",
        logs: [`[NeuroDeploy] Cloning GitHub repository for project "${project.name}"...`],
        diff: null,
        prUrl: null,
      });

      logStep(jobId, "Cloning linked GitHub repository");
      const cloneResult = await cloneProjectRepository(jobId, project, runtime.githubToken);
      repoDir = cloneResult.repoDir;
      branch = cloneResult.branch;
      logStep(jobId, `Repository cloned at ${repoDir}`);

      featureBranch = buildFixBranchName(projectId, jobId);
      logStep(jobId, `Creating feature branch ${featureBranch}`);
      await checkoutBranch(repoDir, featureBranch);

      let fixedAndValidated = false;

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        logStep(jobId, `Attempt ${attempt}: preparing repository snapshot for ${runtime.model.provider}`);

        await job.updateProgress({
          step: "ai_analyzing",
          logs: [
            `[NeuroDeploy] Attempt ${attempt}: Sending codebase to ${runtime.model.provider} (${runtime.model.modelName}) for analysis...`,
          ],
          diff: null,
          prUrl: null,
        });

        const repoSnapshot = await buildRepositorySnapshot(repoDir);
        logStep(jobId, `Attempt ${attempt}: sending repository + deploymentError to ${runtime.model.provider}`);

        const aiFix = await askSelectedModelForFix({
          repoSnapshot,
          deploymenterrro: deploymentError,
          project,
          runtime,
        });

        const plannedChanges = aiFix.files ?? [];
        logStep(jobId, `Attempt ${attempt}: AI responded. files=${plannedChanges.length}`);

        if (plannedChanges.length === 0) {
          logStep(jobId, `Attempt ${attempt}: no code changes proposed by AI model.`);
          break;
        }

        // Build a readable diff for the frontend
        lastDiff = plannedChanges
          .map((f: { path: string; content: string }) => `// ── File: ${f.path} ──\n${f.content}`)
          .join("\n\n");

        const changedCount = await applyGeminiChanges(repoDir, plannedChanges);
        logStep(jobId, `Attempt ${attempt}: applied ${changedCount} file changes`);

        // ── Step 3: Validating ───────────────────────────────────────────────
        await job.updateProgress({
          step: "validating",
          logs: [
            `[NeuroDeploy] Attempt ${attempt}: AI fix applied to ${changedCount} file(s).`,
            aiFix.summary ? `Summary: ${aiFix.summary}` : "",
            "[NeuroDeploy] Running Docker build to validate the fix...",
          ].filter(Boolean),
          diff: lastDiff,
          prUrl: null,
        });

        logStep(jobId, `Attempt ${attempt}: validating repository with Docker`);
        const validation = await validateWithDocker(repoDir, project);
        logStep(jobId, `Attempt ${attempt}: docker result: ok=${validation.ok}`);

        if (validation.ok) {
          fixedAndValidated = true;
          const commitMessage = buildProfessionalCommitMessage({
            projectName: project.name,
            ...(aiFix.commitMessage ? { candidate: aiFix.commitMessage } : {}),
            ...(aiFix.summary ? { summary: aiFix.summary } : {}),
          });

          logStep(jobId, "Validation passed. Pushing changes...");
          const pushed = await pushIfChanged(repoDir, featureBranch, commitMessage);

          let prUrl: string | null = null;
          if (pushed) {
            const owner = project.link?.org;
            const repo = project.link?.repo;
            if (owner && repo) {
              prUrl = await createPullRequest({
                owner,
                repo,
                baseBranch: branch,
                headBranch: featureBranch,
                githubToken: runtime.githubToken,
                title: commitMessage,
                body: [
                  `Automated fix for deployment ${latestDeploymentId ?? "unknown"}.`,
                  "",
                  `**Deployment error:**\n\`\`\`\n${deploymentError ?? "<none>"}\n\`\`\``,
                  "",
                  `**Validation:** ${validation.details}`,
                ].join("\n"),
              });
              logStep(jobId, prUrl ? `PR created: ${prUrl}` : "PR creation returned no URL");
            } else {
              logStep(jobId, "Skipped PR: missing repo owner/name metadata.");
            }
          }

          // ── Step 4: PR Created ─────────────────────────────────────────────
          await job.updateProgress({
            step: "pr_created",
            logs: [
              `[NeuroDeploy] Docker validation PASSED on attempt ${attempt}.`,
              pushed ? `[NeuroDeploy] Code pushed to branch: ${featureBranch}` : "[NeuroDeploy] No git changes to push.",
              prUrl ? `[NeuroDeploy] Pull Request created: ${prUrl}` : "[NeuroDeploy] PR not created (missing repo metadata).",
            ],
            diff: lastDiff,
            prUrl,
          });

          break;
        }

        deploymentError = `Docker validation failed after AI fix. Details:\n${validation.details}`;
        logStep(jobId, `Attempt ${attempt}: validation failed; retrying...`);
      }

      if (!fixedAndValidated) {
        logStep(jobId, "Auto-fix workflow finished without a validated fix.");
        await job.updateProgress({
          step: "failed",
          logs: ["[NeuroDeploy] All 5 attempts exhausted. Could not produce a validated fix."],
          diff: lastDiff,
          prUrl: null,
        });
      }
    } finally {
      if (repoDir) {
        logStep(jobId, "Cleaning up cloned repository directory");
        await rm(repoDir, { recursive: true, force: true });
      }
      logStep(jobId, "Workflow complete");
    }
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`[fixProjectWorker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[fixProjectWorker] failed job ${job?.id}:`, err.message);
});

worker.on("error", (err) => {
  console.error("[fixProjectWorker] worker error:", err);
});

process.on("SIGINT", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});

console.log(`[fixProjectWorker] listening on ${FIX_PROJECT_QUEUE_NAME}`);
