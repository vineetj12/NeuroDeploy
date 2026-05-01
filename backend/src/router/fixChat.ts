import router from "express";
import Anthropic from "@anthropic-ai/sdk";
import { rm } from "node:fs/promises";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { prisma } from "../PrismaClientManager/index.ts";
import { getUserGithubToken, getUserVercelToken } from "../services/credential.service.ts";
import { fetchProjectById } from "../controller/vercel/vercel.ts";
import { cloneProjectRepository } from "../worker/lib/git.ts";
import { buildContextBudget, type DeploymentDiff } from "../worker/contextBudget.ts";
import { ANTHROPIC_API_KEY, FIX_CHAT_MODEL } from "../envdata/data.ts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface FixChatSession {
  jobId: string;
  userId: string;
  history: ChatMessage[];
  contextFiles: Record<string, string>;
  patches: unknown[];
  errorLog: string;
  repoDir: string;
  lastAccessed: number;
}

const MAX_SESSIONS = Number(process.env.FIX_CHAT_MAX_SESSIONS ?? 20);
const SESSION_TTL_MS = Number(process.env.FIX_CHAT_TTL_MS ?? 30 * 60 * 1000);

class FixChatSessionStore {
  private sessions = new Map<string, FixChatSession>();

  async get(key: string): Promise<FixChatSession | null> {
    const session = this.sessions.get(key) ?? null;
    if (!session) return null;

    if (Date.now() - session.lastAccessed > SESSION_TTL_MS) {
      await this.evict(key);
      return null;
    }

    session.lastAccessed = Date.now();
    this.sessions.delete(key);
    this.sessions.set(key, session);
    return session;
  }

  async set(key: string, session: FixChatSession): Promise<void> {
    this.sessions.delete(key);
    this.sessions.set(key, session);
    await this.evictIfNeeded();
  }

  async evict(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    if (session.repoDir) {
      await rm(session.repoDir, { recursive: true, force: true });
    }
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string | undefined;
      if (!oldestKey) break;
      await this.evict(oldestKey);
    }
  }
}

const store = new FixChatSessionStore();

export const fixChatRouter = router.Router();

fixChatRouter.post("/jobs/:jobId/chat", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const jobId = req.params.jobId as string;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!message) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Anthropic API key is not configured" });
    return;
  }

  const sessionKey = `${userId}:${jobId}`;
  let session = await store.get(sessionKey);

  if (!session) {
    const job = await prisma.fixJob.findFirst({
      where: { bullmqJobId: jobId, userId },
    });

    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const vercelToken = await getUserVercelToken(userId);
    const githubToken = await getUserGithubToken(userId);
    const project = await fetchProjectById(job.projectId, vercelToken);

    const cloneResult = await cloneProjectRepository(`fix-chat-${jobId}`, project, githubToken);
    const repoDir = cloneResult.repoDir;

    const patches = Array.isArray(job.patchJson) ? (job.patchJson as unknown[]) : [];
    const diff: DeploymentDiff = {
      changedFiles: patches
        .map((entry: any) => (entry?.path ? { filename: String(entry.path) } : null))
        .filter((entry): entry is { filename: string } => !!entry),
    };

    const errorLog = job.errorMessage ?? "";
    const ranked = await buildContextBudget(repoDir, errorLog, diff, FIX_CHAT_MODEL);
    const contextFiles: Record<string, string> = {};
    for (const file of ranked) {
      contextFiles[file.path] = file.content;
    }

    session = {
      jobId,
      userId,
      history: [],
      contextFiles,
      patches,
      errorLog,
      repoDir,
      lastAccessed: Date.now(),
    };

    await store.set(sessionKey, session);
  }

  session.history.push({ role: "user", content: message });

  const systemPrompt = [
    "You are NeuroDeploy's AI assistant. You have full context of a deployment fix.",
    "",
    "ORIGINAL ERROR:",
    session.errorLog || "<none>",
    "",
    "PATCHES APPLIED:",
    JSON.stringify(session.patches ?? [], null, 2),
    "",
    "RELEVANT CODEBASE FILES:",
    Object.entries(session.contextFiles)
      .map(([fp, content]) => `// ${fp}\n${content}`)
      .join("\n\n---\n\n"),
    "",
    "Answer the developer's questions about this fix precisely.",
    "If asked to find patterns in the codebase, search the provided files.",
    "If asked \"what would happen if\", reason through the code carefully.",
    "Be concise and technical.",
  ].join("\n");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let fullResponse = "";

  try {
    const stream = await client.messages.stream({
      model: FIX_CHAT_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: session.history.map((item) => ({ role: item.role, content: item.content })),
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullResponse += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
      }
    }

    session.history.push({ role: "assistant", content: fullResponse });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error("[fixChat] stream error:", error);
    res.write(`data: ${JSON.stringify({ error: "Chat stream failed" })}\n\n`);
    res.end();
  }
});
