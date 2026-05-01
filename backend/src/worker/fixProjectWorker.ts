import { Queue, Worker } from "bullmq";
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
import { createFixJob, updateFixJobStatus, completeFixJob } from "../services/fixJob.service.ts";
import { classifyError } from "../services/errorClassifier.ts";
import { DistributedRepoLock, LockConflictError } from "./distributedLock.ts";
import { prisma } from "../PrismaClientManager/index.ts";
import { isDeploymentStillRelevant } from "./deadLetter.ts";

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 10000,
  retryStrategy: (times: number) => Math.min(2000 * times, 30000),
};

if (REDIS_URL.startsWith("rediss://")) {
  redisOptions.tls = {};
}

const connection = new Redis(REDIS_URL, redisOptions);
const statusQueue = new Queue(FIX_PROJECT_QUEUE_NAME, { connection });
const statusLogMs = Number(process.env.WORKER_STATUS_LOG_MS ?? 60000);
let statusTimer: NodeJS.Timeout | null = null;

process.on("uncaughtException", (err) => {
  console.error("[fixProjectWorker] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fixProjectWorker] unhandledRejection:", reason);
});

async function logQueueStatus(): Promise<void> {
  try {
    const counts = await statusQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    console.log(
      `[fixProjectWorker] queue status: waiting=${counts.waiting} active=${counts.active} delayed=${counts.delayed} failed=${counts.failed} completed=${counts.completed}`
    );
  } catch (error) {
    console.warn("[fixProjectWorker] failed to fetch queue status:", error);
  }
}

async function publishLog(jobId: string, message: string, level = "info"): Promise<void> {
  const entry = JSON.stringify({ message, level, ts: Date.now() });
  await connection.publish(`job:${jobId}:log`, entry);
  await connection.rpush(`job:${jobId}:logs`, entry);
  await connection.expire(`job:${jobId}:logs`, 86400); // 24h
  console.log(`[fixProjectWorker][job=${jobId}] ${message}`);
}

  const worker = new Worker<FixProjectJobData>(
  FIX_PROJECT_QUEUE_NAME,
  async (job) => {
    const { projectId, latestDeploymentId, userId } = job.data;
    const jobId = String(job.id ?? "unknown");
    const startTime = Date.now();
    let dbFixJobId: string | null = null;
    let repoLock: DistributedRepoLock | null = null;
    
    await publishLog(jobId, "Starting auto-fix workflow");

    if (!userId || userId.trim() === "") {
      await publishLog(jobId, "Skipping job because userId is missing (required for DB-backed credentials).", "error");
      return;
    }

    const runtime = await loadWorkerRuntimeCredentials(userId);
    const project = await fetchProjectById(projectId, runtime.vercelToken);

    const repoFullName = project.link?.org && project.link?.repo
      ? `${project.link.org}/${project.link.repo}`
      : null;

    if (repoFullName) {
      repoLock = new DistributedRepoLock(connection, repoFullName);
      try {
        await repoLock.acquire();
        await publishLog(jobId, `🔒 Acquired lock for ${repoFullName}`);
      } catch (error) {
        if (error instanceof LockConflictError) {
          await publishLog(jobId, `⏳ ${error.message}`, "warn");
          await job.updateProgress({
            step: "delayed",
            logs: ["Another worker is already processing this repo. Re-queueing job."],
            diff: null,
            prUrl: null,
          });
          await job.moveToDelayed(Date.now() + 60_000);
          return;
        }
        throw error;
      }
    } else {
      await publishLog(jobId, "⚠️ Missing repo metadata (owner/repo). Proceeding without lock.", "warn");
    }

    let deploymentError = latestDeploymentId
      ? await fetchDeploymentError(latestDeploymentId, runtime.vercelToken)
      : "No deployment id provided.";

    await publishLog(jobId, `deploymentError=${deploymentError ?? "<none>"}`);

    // Create DB Record
    const errorCategory = classifyError(deploymentError ?? "");
    const fixJobRecord = await createFixJob({
      userId,
      projectId,
      projectName: project.name,
      deploymentId: latestDeploymentId ?? undefined,
      bullmqJobId: jobId,
      errorCategory,
      errorMessage: deploymentError ?? undefined,
      aiProvider: runtime.model.provider,
      aiModel: runtime.model.modelName,
    });
    dbFixJobId = fixJobRecord.id;

    // ── Step 1: Error Detected ───────────────────────────────────────────────
    await job.updateProgress({
      step: "error_detected",
      logs: [`[NeuroDeploy] Deployment failure detected for project "${project.name}".`, deploymentError ?? "No error message."],
      diff: null,
      prUrl: null,
    });

    if (!deploymentError) {
      await publishLog(jobId, "No deployment error detected. Nothing to fix.");
      await job.updateProgress({
        step: "no_error",
        logs: ["No deployment error detected. Nothing to fix."],
        diff: null,
        prUrl: null,
      });
      if (dbFixJobId) {
        await completeFixJob(dbFixJobId, { status: "FAILED", durationMs: Date.now() - startTime });
      }
      if (repoLock) {
        await repoLock.release();
      }
      return;
    }

    let repoDir = "";
    let branch = "main";
    let featureBranch = "";
    let lastDiff: string | null = null;
    let finalReasoning: any = null;

    try {
      // ── Step 2: AI Analyzing ─────────────────────────────────────────────
      await publishLog(jobId, `📦 Cloning GitHub repository for project "${project.name}"...`);
      await job.updateProgress({
        step: "ai_analyzing",
        logs: [`[NeuroDeploy] Cloning GitHub repository for project "${project.name}"...`],
        diff: null,
        prUrl: null,
      });

      repoLock?.assertActive();
      const cloneResult = await cloneProjectRepository(jobId, project, runtime.githubToken);
      repoDir = cloneResult.repoDir;
      branch = cloneResult.branch;
      await publishLog(jobId, `📁 Repository cloned at ${repoDir}`);

      featureBranch = buildFixBranchName(projectId, jobId);
      repoLock?.assertActive();
      await checkoutBranch(repoDir, featureBranch);

      let fixedAndValidated = false;

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        repoLock?.assertActive();
        if (dbFixJobId) {
          await updateFixJobStatus(dbFixJobId, "ANALYZING");
        }
        await publishLog(jobId, `🤖 Attempt ${attempt}: Sending codebase to ${runtime.model.provider} for analysis...`);

        await job.updateProgress({
          step: "ai_analyzing",
          logs: [
            `[NeuroDeploy] Attempt ${attempt}: Sending codebase to ${runtime.model.provider} (${runtime.model.modelName}) for analysis...`,
          ],
          diff: null,
          prUrl: null,
        });

        const repoSnapshot = await buildRepositorySnapshot(repoDir);
        repoLock?.assertActive();
        const aiFix = await askSelectedModelForFix({
          repoSnapshot,
          deploymenterrro: deploymentError,
          project,
          runtime,
        });

        const plannedChanges = aiFix.files ?? [];
        await publishLog(jobId, `🧠 Attempt ${attempt}: AI responded with ${plannedChanges.length} file changes.`);

        if (dbFixJobId && plannedChanges.length > 0) {
          try {
            await prisma.fixJob.update({
              where: { id: dbFixJobId },
              data: { patchJson: plannedChanges as any },
            });
          } catch (error) {
            console.warn("[fixProjectWorker] failed to store patchJson:", error);
          }
        }

        if (plannedChanges.length === 0) {
          await publishLog(jobId, `⚠️ Attempt ${attempt}: no code changes proposed by AI model.`, "warn");
          break;
        }

        // Build a readable diff for the frontend
        lastDiff = plannedChanges
          .map((f: { path: string; content: string }) => `// ── File: ${f.path} ──\n${f.content}`)
          .join("\n\n");

        // Build AI reasoning data for the frontend
        finalReasoning = {
          overallSummary: aiFix.overallSummary ?? aiFix.summary ?? undefined,
          estimatedRiskLevel: aiFix.estimatedRiskLevel ?? undefined,
          patches: plannedChanges.map((f) => ({
            filePath: f.path,
            rootCause: f.rootCause ?? "Not provided",
            fixStrategy: f.fixStrategy ?? "Not provided",
            confidenceScore: typeof f.confidenceScore === "number" ? f.confidenceScore : 0,
            alternativesConsidered: Array.isArray(f.alternativesConsidered) ? f.alternativesConsidered : [],
          })),
        };

        const changedCount = await applyGeminiChanges(repoDir, plannedChanges);
        await publishLog(jobId, `💾 Attempt ${attempt}: applied ${changedCount} file changes`);

        // ── Step 3: Validating ───────────────────────────────────────────────
        if (dbFixJobId) {
          await updateFixJobStatus(dbFixJobId, "VALIDATING");
        }
        await job.updateProgress({
          step: "validating",
          logs: [
            `[NeuroDeploy] Attempt ${attempt}: AI fix applied to ${changedCount} file(s).`,
            aiFix.summary ? `Summary: ${aiFix.summary}` : "",
            "[NeuroDeploy] Running Docker build to validate the fix...",
          ].filter(Boolean),
          diff: lastDiff,
          prUrl: null,
          aiReasoning: finalReasoning,
        });

        await publishLog(jobId, `🐳 Attempt ${attempt}: validating repository with Docker...`);
        const validation = await validateWithDocker(repoDir, project);
        await publishLog(jobId, `🐳 Attempt ${attempt}: docker validation ${validation.ok ? "PASSED ✅" : "FAILED ❌"}`);
        repoLock?.assertActive();

        if (validation.ok) {
          fixedAndValidated = true;
          const commitMessage = buildProfessionalCommitMessage({
            projectName: project.name,
            ...(aiFix.commitMessage ? { candidate: aiFix.commitMessage } : {}),
            ...(aiFix.summary ? { summary: aiFix.summary } : {}),
          });

          await publishLog(jobId, "🚀 Validation passed. Pushing changes...");
          repoLock?.assertActive();
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
              await publishLog(jobId, prUrl ? `🎉 PR created: ${prUrl}` : "⚠️ PR creation returned no URL");
            } else {
              await publishLog(jobId, "⚠️ Skipped PR: missing repo owner/name metadata.", "warn");
            }
          }

          if (dbFixJobId) {
            const avgConfidence = finalReasoning?.patches?.reduce((acc: number, p: any) => acc + p.confidenceScore, 0) / (finalReasoning?.patches?.length || 1);
            await completeFixJob(dbFixJobId, {
              status: "PR_CREATED",
              prUrl,
              confidenceScore: avgConfidence,
              riskLevel: finalReasoning?.estimatedRiskLevel,
              filesChanged: finalReasoning?.patches?.length ?? 0,
              fixedFiles: finalReasoning?.patches?.map((p: any) => p.filePath) ?? [],
              durationMs: Date.now() - startTime,
            });
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
            aiReasoning: finalReasoning,
          });

          break;
        }

        deploymentError = `Docker validation failed after AI fix. Details:\n${validation.details}`;
        await publishLog(jobId, `❌ Attempt ${attempt}: validation failed; retrying...`, "warn");
      }

      if (!fixedAndValidated) {
        await publishLog(jobId, "❌ Auto-fix workflow finished without a validated fix.", "error");
        
        if (dbFixJobId) {
          await completeFixJob(dbFixJobId, {
            status: "FAILED",
            durationMs: Date.now() - startTime,
          });
        }
        
        await job.updateProgress({
          step: "failed",
          logs: ["[NeuroDeploy] All 5 attempts exhausted. Could not produce a validated fix."],
          diff: lastDiff,
          prUrl: null,
        });
      }
    } finally {
      if (repoLock) {
        await repoLock.release();
      }
      if (repoDir) {
        await publishLog(jobId, "🧹 Cleaning up cloned repository directory...");
        await rm(repoDir, { recursive: true, force: true });
      }
      await publishLog(jobId, "✅ Workflow complete.");
    }
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`[fixProjectWorker] completed job ${job.id}`);
});

worker.on("active", (job) => {
  console.log(`[fixProjectWorker] started job ${job.id}`);
});

worker.on("failed", async (job, err) => {
  console.error(`[fixProjectWorker] failed job ${job?.id}:`, err.message);

  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;

  const userId = (job.data as FixProjectJobData)?.userId ?? null;
  try {
    await prisma.deadLetterJob.create({
      data: {
        originalJobId: String(job.id ?? "unknown"),
        userId,
        webhookPayload: job.data as any,
        failureReason: err.message || "Job failed",
        failureStack: err.stack ?? "",
        attemptCount: job.attemptsMade,
        firstFailedAt: new Date(job.timestamp ?? Date.now()),
        lastFailedAt: new Date(),
        canReplay: isDeploymentStillRelevant(job.timestamp),
      },
    });
  } catch (error) {
    console.error("[fixProjectWorker] failed to persist dead letter entry:", error);
  }
});

worker.on("error", (err) => {
  console.error("[fixProjectWorker] worker error:", err);
});

process.on("SIGINT", async () => {
  if (statusTimer) clearInterval(statusTimer);
  await worker.close();
  await statusQueue.close();
  await connection.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (statusTimer) clearInterval(statusTimer);
  await worker.close();
  await statusQueue.close();
  await connection.quit();
  process.exit(0);
});

if (statusLogMs > 0) {
  statusTimer = setInterval(() => {
    void logQueueStatus();
  }, statusLogMs);
  void logQueueStatus();
}

console.log(`[fixProjectWorker] listening on ${FIX_PROJECT_QUEUE_NAME}`);
