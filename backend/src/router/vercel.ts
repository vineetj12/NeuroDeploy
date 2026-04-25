import router from "express";
import { fetchProjectById, fetchProjects } from "../controller/vercel/vercel.ts";
import { handleVercelWebhook } from "../controller/vercel/webhook/handler.ts";
import { getUserVercelToken } from "../services/credential.service.ts";
import { fixProject } from "../services/fix.service.ts";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REDIS_URL } from "../envdata/data.ts";
import { FIX_PROJECT_QUEUE_NAME } from "../queue/fixProjectQueue.ts";

const _queueRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const _fixQueue = new Queue(FIX_PROJECT_QUEUE_NAME, { connection: _queueRedis });

export const vercelRouter = router.Router();

// ── GET /api/vercel/projects ─────────────────────────────────────────────────

vercelRouter.get("/projects", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  try {
    const vercelToken = await getUserVercelToken(userId);
    console.log("[vercel] Fetching all projects...");
    const projects = await fetchProjects(vercelToken);
    console.log(`[vercel] Fetched ${projects.length} projects`);
    res.json(projects);
  } catch (error: any) {
    console.error("[vercel] Error fetching projects:", error.message || error);
    
    // Check if it's our own credential error or a Vercel API auth error
    if (
      error.message === "Vercel credential not found for this user." ||
      error.response?.status === 401 ||
      error.response?.status === 403
    ) {
      res.status(403).json({ error: "NO_CREDENTIALS" });
      return;
    }

    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// ── GET /api/vercel/projects/:id ─────────────────────────────────────────────

vercelRouter.get("/projects/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const projectId = req.params.id as string;
  const userId = req.userId!;
  try {
    const vercelToken = await getUserVercelToken(userId);
    console.log(`[vercel] Fetching project ${projectId}...`);
    const project = await fetchProjectById(projectId, vercelToken);
    const latest = project.targets?.production || project.latestDeployments?.[0];
    const failed = latest?.readyState === "ERROR";
    const latestDeploymentId = latest?.id ?? null;
    console.log(`[vercel] Project ${projectId}: name=${project.name} readyState=${latest?.readyState}`);
    res.json({ project, failed, latestDeploymentId });
  } catch (error) {
    console.error("[vercel] Error fetching project by ID:", error);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// ── POST /api/vercel/projects/:id/fix ───────────────────────────────────────

vercelRouter.post("/projects/:id/fix", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const projectId = req.params.id as string;
  const userId = req.userId!;
  console.log(`[vercel/fix] Received fix request: projectId=${projectId} userId=${userId}`);
  try {
    console.log("[vercel/fix] Step 1: Looking up Vercel token...");
    const vercelToken = await getUserVercelToken(userId);

    console.log("[vercel/fix] Step 2: Fetching project from Vercel API...");
    const project = await fetchProjectById(projectId, vercelToken);
    const latest = project.targets?.production || project.latestDeployments?.[0];
    const latestDeploymentId = latest?.id ?? null;
    console.log(`[vercel/fix] Step 3: Project fetched. name=${project.name} latestDeploymentId=${latestDeploymentId}`);

    console.log("[vercel/fix] Step 4: Enqueueing fix job...");
    const jobId = await fixProject(projectId, latestDeploymentId, userId);
    console.log(`[vercel/fix] Step 5: Job enqueued! jobId=${jobId}`);

    res.json({ queued: true, projectId, latestDeploymentId, userId, jobId });
  } catch (error) {
    console.error("[vercel/fix] Error queueing project fix:", error);
    res.status(500).json({ error: "Failed to queue project fix" });
  }
});

// ── GET /api/vercel/jobs/:jobId/status ──────────────────────────────────────

vercelRouter.get("/jobs/:jobId/status", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const jobId = req.params.jobId as string;
  try {
    const job = await _fixQueue.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const state = await job.getState();
    const progress = job.progress as Record<string, unknown> | number;
    res.json({ jobId, state, progress });
  } catch (error) {
    console.error("[vercel/jobs] Error fetching job status:", error);
    res.status(500).json({ error: "Failed to fetch job status" });
  }
});

// ── POST /api/vercel/webhook ─────────────────────────────────────────────────

vercelRouter.post("/webhook", async (req, res) => {
  try {
    await handleVercelWebhook(req, res);
  } catch (error) {
    console.error("[vercel] Error handling webhook:", error);
    res.status(500).json({ error: "Failed to handle webhook" });
  }
});