import router from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  getAnalyticsSummary,
  getAnalyticsTimeline,
  getAnalyticsFiles,
} from "../services/fixJob.service.ts";

export const analyticsRouter = router.Router();

// ── GET /api/analytics/summary ───────────────────────────────────────────────

analyticsRouter.get("/summary", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  try {
    const summary = await getAnalyticsSummary(userId);
    res.json(summary);
  } catch (error) {
    console.error("[analytics] Error fetching summary:", error);
    res.status(500).json({ error: "Failed to fetch analytics summary" });
  }
});

// ── GET /api/analytics/timeline ──────────────────────────────────────────────

analyticsRouter.get("/timeline", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const days = Math.min(Number(req.query.days) || 30, 90);
  try {
    const timeline = await getAnalyticsTimeline(userId, days);
    res.json(timeline);
  } catch (error) {
    console.error("[analytics] Error fetching timeline:", error);
    res.status(500).json({ error: "Failed to fetch analytics timeline" });
  }
});

// ── GET /api/analytics/files ─────────────────────────────────────────────────

analyticsRouter.get("/files", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  try {
    const files = await getAnalyticsFiles(userId, limit);
    res.json(files);
  } catch (error) {
    console.error("[analytics] Error fetching files:", error);
    res.status(500).json({ error: "Failed to fetch analytics files" });
  }
});
