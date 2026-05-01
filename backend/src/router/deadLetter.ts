import router from "express";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REDIS_URL } from "../envdata/data.ts";
import { FIX_PROJECT_QUEUE_NAME } from "../queue/fixProjectQueue.ts";
import { prisma } from "../PrismaClientManager/index.ts";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";

const _queueRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const _fixQueue = new Queue(FIX_PROJECT_QUEUE_NAME, { connection: _queueRedis });

export const deadLetterRouter = router.Router();

// ── GET /api/dead-letter ────────────────────────────────────────────────────

deadLetterRouter.get("/", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  try {
    const entries = await prisma.deadLetterJob.findMany({
      where: { userId, dismissedAt: null },
      orderBy: { lastFailedAt: "desc" },
      take: 200,
    });
    res.json(entries);
  } catch (error) {
    console.error("[dead-letter] Error fetching entries:", error);
    res.status(500).json({ error: "Failed to fetch dead letter entries" });
  }
});

// ── POST /api/dead-letter/:id/replay ───────────────────────────────────────

deadLetterRouter.post("/:id/replay", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id as string;

  try {
    const entry = await prisma.deadLetterJob.findFirst({
      where: { id, userId },
    });

    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (!entry.canReplay) {
      res.status(400).json({ error: "Deployment too old to replay" });
      return;
    }

    if (entry.dismissedAt) {
      res.status(400).json({ error: "Entry was dismissed" });
      return;
    }

    const newJob = await _fixQueue.add("fix-project", entry.webhookPayload as any, {
      attempts: 5,
      jobId: `replay-${entry.id}-${Date.now()}`,
    });

    await prisma.deadLetterJob.update({
      where: { id: entry.id },
      data: { replayedAt: new Date(), replayJobId: String(newJob.id) },
    });

    res.json({ newJobId: newJob.id });
  } catch (error) {
    console.error("[dead-letter] Error replaying entry:", error);
    res.status(500).json({ error: "Failed to replay job" });
  }
});

// ── POST /api/dead-letter/:id/dismiss ──────────────────────────────────────

deadLetterRouter.post("/:id/dismiss", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id as string;

  try {
    const entry = await prisma.deadLetterJob.findFirst({ where: { id, userId } });
    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await prisma.deadLetterJob.update({
      where: { id },
      data: { dismissedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("[dead-letter] Error dismissing entry:", error);
    res.status(500).json({ error: "Failed to dismiss entry" });
  }
});
