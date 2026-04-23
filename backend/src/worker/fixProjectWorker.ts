import axios from "axios";
import { Worker } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import Docker from "dockerode";
import { rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import tar from "tar-fs";
import {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  REDIS_URL,
} from "../envdata/data.js";
import { prisma } from "../PrismaClientManager/index.ts";
import { fetchProjectById } from "../controller/vercel/vercel.ts";
import { FIX_PROJECT_QUEUE_NAME, type FixProjectJobData } from "../queue/fixProjectQueue.js";
import type { VercelProject } from "../types.js";

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

type DeploymentEvent = {
  text?: string;
  payload?: {
    text?: string;
    info?: {
      readyState?: string;
      step?: string;
    };
  };
};

type GeminiFileChange = {
  path: string;
  content: string;
};

type GeminiFixResponse = {
  summary?: string;
  files?: GeminiFileChange[];
  commitMessage?: string;
};

type DockerValidationResult = {
  ok: boolean;
  skipped?: boolean;
  details: string;
};

type SupportedModelProvider = "GEMINI" | "ANTHROPIC" | "OPENAI" | "DEEPSEEK";

type SelectedModelRuntime = {
  provider: SupportedModelProvider;
  modelName: string;
  apiKey: string;
};

type WorkerRuntimeCredentials = {
  githubToken: string;
  vercelToken: string;
  model: SelectedModelRuntime;
};

const docker = new Docker();
const MAX_REPO_TEXT_BYTES = 2_000_000;
const MAX_FILE_BYTES = 250_000;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".vercel",
  ".turbo",
  ".cache",
]);
const PREFERRED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "requirements.txt",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "vercel.json",
  ".env.example",
  "README.md",
];

function asSupportedProvider(value: string): SupportedModelProvider | null {
  if (value === "GEMINI" || value === "ANTHROPIC" || value === "OPENAI" || value === "DEEPSEEK") {
    return value;
  }
  return null;
}

async function getLatestCredentialSecret(userId: string, provider: "GITHUB" | "VERCEL"): Promise<string | null> {
  const credential = await prisma.userCredential.findFirst({
    where: { userId, provider },
    orderBy: { updatedAt: "desc" },
  });

  return credential?.secret?.trim() || null;
}

async function resolveModelRuntime(userId: string): Promise<SelectedModelRuntime> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { selectedModel: true },
  });

  if (!user) {
    throw new Error(`User not found for id=${userId}`);
  }

  if (!user.selectedModelId || !user.selectedModel) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === "") {
      throw new Error("No model selected and GEMINI_API_KEY fallback is missing.");
    }

    return {
      provider: "GEMINI",
      modelName: GEMINI_MODEL,
      apiKey: GEMINI_API_KEY,
    };
  }

  const provider = asSupportedProvider(user.selectedModel.provider);
  if (!provider) {
    throw new Error(`Selected model provider ${user.selectedModel.provider} is not supported yet.`);
  }

  const modelKey = await prisma.userModelKey.findUnique({
    where: {
      userId_modelId: {
        userId,
        modelId: user.selectedModelId,
      },
    },
  });

  if (!modelKey?.apiKey || modelKey.apiKey.trim() === "") {
    throw new Error(`API key missing for selected model ${user.selectedModel.name}.`);
  }

  return {
    provider,
    modelName: user.selectedModel.name,
    apiKey: modelKey.apiKey,
  };
}

async function loadWorkerRuntimeCredentials(userId: string): Promise<WorkerRuntimeCredentials> {
  const [githubToken, vercelToken, model] = await Promise.all([
    getLatestCredentialSecret(userId, "GITHUB"),
    getLatestCredentialSecret(userId, "VERCEL"),
    resolveModelRuntime(userId),
  ]);

  if (!githubToken) {
    throw new Error("GitHub credential is missing for the user.");
  }

  if (!vercelToken) {
    throw new Error("Vercel credential is missing for the user.");
  }

  return {
    githubToken,
    vercelToken,
    model,
  };
}

function getVercelHeaders(vercelToken: string) {
  if (!vercelToken || vercelToken.trim() === "") {
    throw new Error("User Vercel token is missing.");
  }

  return {
    Authorization: `Bearer ${vercelToken}`,
  };
}

async function fetchDeploymentError(deploymentId: string, vercelToken: string): Promise<string | null> {
  try {
    const response = await axios.get<DeploymentEvent[] | { events?: DeploymentEvent[] }>(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events`,
      {
        params: {
          limit: -1,
          builds: 1,
        },
        headers: getVercelHeaders(vercelToken),
      }
    );

    const events = Array.isArray(response.data) ? response.data : response.data.events ?? [];
    const logLines = events
      .flatMap((event) => [event.text, event.payload?.text])
      .filter((line): line is string => typeof line === "string");

    for (let i = logLines.length - 1; i >= 0; i -= 1) {
      const line = logLines[i];
      if (!line) {
        continue;
      }

      const normalizedLine = line.trim();
      if (/error|failed|exception|fatal/i.test(normalizedLine)) {
        return normalizedLine;
      }
    }

    const hasErrorState = events.some((event) => event.payload?.info?.readyState === "ERROR");
    if (hasErrorState) {
      return "Deployment finished with ERROR state, but no explicit error line was found.";
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      return `Failed to fetch deployment events: ${error.message}`;
    }
    return "Failed to fetch deployment events.";
  }
};

function getSafeEnvSnapshot(runtime: WorkerRuntimeCredentials): string {
  const envEntries = [
    ["NODE_ENV", process.env.NODE_ENV || ""],
    ["PORT", process.env.PORT || ""],
    ["FRONTEND_ORIGIN", process.env.FRONTEND_ORIGIN || ""],
    ["REDIS_URL", process.env.REDIS_URL || ""],
    ["DATABASE_URL", process.env.DATABASE_URL ? "<redacted>" : ""],
    ["JWT_SECRET", process.env.JWT_SECRET ? "<redacted>" : ""],
    ["GEMINI_API_KEY", process.env.GEMINI_API_KEY ? "<redacted>" : ""],
    ["GEMINI_MODEL", process.env.GEMINI_MODEL || ""],
    ["USER_VERCEL_TOKEN", runtime.vercelToken ? "<redacted>" : ""],
    ["USER_GITHUB_TOKEN", runtime.githubToken ? "<redacted>" : ""],
    ["SELECTED_MODEL_PROVIDER", runtime.model.provider],
    ["SELECTED_MODEL_NAME", runtime.model.modelName],
  ];

  return envEntries.map(([key, value]) => `${key}=${value}`).join("\n");
}

function isProbablyTextFile(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".7z",
    ".jar",
    ".woff",
    ".woff2",
    ".ttf",
    ".mp4",
    ".mp3",
  ];
  return !binaryExtensions.some((ext) => lowered.endsWith(ext));
}

async function collectRepositoryFiles(rootDir: string): Promise<string[]> {
  const collected: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && isProbablyTextFile(relPath)) {
        collected.push(relPath);
      }
    }
  }

  await walk(rootDir);
  collected.sort((a, b) => {
    const aPreferred = PREFERRED_FILES.includes(a) ? 0 : 1;
    const bPreferred = PREFERRED_FILES.includes(b) ? 0 : 1;
    if (aPreferred !== bPreferred) {
      return aPreferred - bPreferred;
    }
    return a.localeCompare(b);
  });
  return collected;
}

async function buildRepositorySnapshot(rootDir: string): Promise<string> {
  const files = await collectRepositoryFiles(rootDir);
  const chunks: string[] = [];
  let usedBytes = 0;

  for (const relPath of files) {
    const fullPath = join(rootDir, relPath);
    let content: string;

    try {
      const raw = await readFile(fullPath);
      if (raw.byteLength > MAX_FILE_BYTES) {
        continue;
      }
      content = raw.toString("utf8");
    } catch {
      continue;
    }

    const section = `\n--- FILE: ${relPath} ---\n${content}\n`;
    const sectionBytes = Buffer.byteLength(section);
    if (usedBytes + sectionBytes > MAX_REPO_TEXT_BYTES) {
      break;
    }

    chunks.push(section);
    usedBytes += sectionBytes;
  }

  return chunks.join("\n");
}

function extractJsonObject(text: string): string | null {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

function buildFixPrompt(input: {
  repoSnapshot: string;
  deploymenterrro: string;
  project: VercelProject;
  runtime: WorkerRuntimeCredentials;
}): string {
  return [
    "You are a senior software engineer. Fix the deployment failure in the repository.",
    "Return ONLY valid JSON. No markdown.",
    "Schema:",
    "{",
    '  "summary": "short summary",',
    '  "commitMessage": "fix: ...",',
    '  "files": [{ "path": "relative/path", "content": "full file content" }]',
    "}",
    "If no code change is needed, return files as an empty array and explain in summary.",
    "Do not include binary files.",
    "",
    `Project metadata: buildCommand=${input.project.buildCommand ?? "<none>"}, installCommand=${input.project.installCommand ?? "<none>"}, outputDirectory=${input.project.outputDirectory ?? "<none>"}, framework=${input.project.framework ?? "<none>"}`,
    "",
    "Deployment error:",
    input.deploymenterrro,
    "",
    "Environment snapshot (secrets are redacted):",
    getSafeEnvSnapshot(input.runtime),
    "",
    "Repository snapshot:",
    input.repoSnapshot,
  ].join("\n");
}

async function askGeminiForFix(prompt: string, model: SelectedModelRuntime): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.modelName)}:generateContent`;
  const response = await axios.post(
    endpoint,
    {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    },
    {
      params: { key: model.apiKey },
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
    }
  );

  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function askOpenAICompatibleForFix(input: {
  prompt: string;
  model: SelectedModelRuntime;
  baseUrl: string;
}): Promise<string> {
  const response = await axios.post(
    `${input.baseUrl}/chat/completions`,
    {
      model: input.model.modelName,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a senior software engineer. Return only valid JSON." },
        { role: "user", content: input.prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${input.model.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    }
  );

  return response.data?.choices?.[0]?.message?.content ?? "";
}

async function askAnthropicForFix(prompt: string, model: SelectedModelRuntime): Promise<string> {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: model.modelName,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": model.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 120000,
    }
  );

  const parts = response.data?.content;
  if (!Array.isArray(parts)) {
    return "";
  }

  const textPart = parts.find((part: { type?: string; text?: string }) => part?.type === "text");
  return textPart?.text ?? "";
}

async function askSelectedModelForFix(input: {
  repoSnapshot: string;
  deploymenterrro: string;
  project: VercelProject;
  runtime: WorkerRuntimeCredentials;
}): Promise<GeminiFixResponse> {
  const prompt = buildFixPrompt(input);

  let text = "";
  if (input.runtime.model.provider === "GEMINI") {
    text = await askGeminiForFix(prompt, input.runtime.model);
  } else if (input.runtime.model.provider === "OPENAI") {
    text = await askOpenAICompatibleForFix({
      prompt,
      model: input.runtime.model,
      baseUrl: "https://api.openai.com/v1",
    });
  } else if (input.runtime.model.provider === "DEEPSEEK") {
    text = await askOpenAICompatibleForFix({
      prompt,
      model: input.runtime.model,
      baseUrl: "https://api.deepseek.com",
    });
  } else if (input.runtime.model.provider === "ANTHROPIC") {
    text = await askAnthropicForFix(prompt, input.runtime.model);
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Model returned an empty response.");
  }

  const jsonBody = extractJsonObject(text);
  if (!jsonBody) {
    throw new Error("Gemini response did not contain a JSON object.");
  }

  const parsed = JSON.parse(jsonBody) as GeminiFixResponse;
  if (!Array.isArray(parsed.files)) {
    parsed.files = [];
  }
  return parsed;
}

function sanitizeRelativePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("../") || normalized.includes("..\\")) {
    throw new Error(`Unsafe file path from model: ${filePath}`);
  }
  return normalized;
}

async function applyGeminiChanges(repoDir: string, changes: GeminiFileChange[]): Promise<number> {
  let changedCount = 0;

  for (const change of changes) {
    const safePath = sanitizeRelativePath(change.path);
    const absPath = join(repoDir, safePath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, change.content, "utf8");
    changedCount += 1;
  }

  return changedCount;
}

function followDockerStream(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
      (event: { errorDetail?: { message?: string } }) => {
        if (event?.errorDetail?.message) {
          reject(new Error(event.errorDetail.message));
        }
      }
    );
  });
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function validateWithDocker(repoDir: string): Promise<DockerValidationResult> {
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return {
      ok: true,
      skipped: true,
      details: "Docker is not available in this environment. Skipping validation.",
    };
  }

  const dockerfilePath = join(repoDir, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    return {
      ok: true,
      skipped: true,
      details: "No Dockerfile in repository. Skipping Docker validation.",
    };
  }

  const tag = `neurodeploy-autofix:${Date.now()}`;
  let containerId: string | null = null;

  try {
    const tarStream = tar.pack(repoDir);
    const buildStream = await docker.buildImage(tarStream, { t: tag });
    await followDockerStream(buildStream);

    const container = await docker.createContainer({
      Image: tag,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    containerId = container.id;

    await container.start();
    const result = await Promise.race([
      container.wait(),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 30000);
      }),
    ]);

    const logsBuffer = await container.logs({ stdout: true, stderr: true });
    const logs = logsBuffer.toString("utf8");

    if (result === "timeout") {
      return {
        ok: true,
        details: `Container kept running for 30s. Logs:\n${logs}`,
      };
    }

    if (typeof result?.StatusCode === "number" && result.StatusCode !== 0) {
      return {
        ok: false,
        details: `Container exited with code ${result.StatusCode}. Logs:\n${logs}`,
      };
    }

    return {
      ok: true,
      details: `Container run completed successfully. Logs:\n${logs}`,
    };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, details: error.message };
    }
    return { ok: false, details: "Unknown docker validation error." };
  } finally {
    if (containerId) {
      try {
        const container = docker.getContainer(containerId);
        await container.remove({ force: true });
      } catch {
        // no-op cleanup
      }
    }

    try {
      const image = docker.getImage(tag);
      await image.remove({ force: true });
    } catch {
      // no-op cleanup
    }
  }
}

async function cloneProjectRepository(
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

async function pushIfChanged(repoDir: string, branch: string, message: string): Promise<boolean> {
  const git = simpleGit(repoDir);
  const status = await git.status();
  if (status.files.length === 0) {
    return false;
  }

  await git.add(["."]);
  await git.commit(message);
  await git.push("origin", branch);
  return true;
}

function buildFixBranchName(projectId: string, jobId: string): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9-_]/g, "-");
  return `neurodeploy/fix-${safeProjectId}-${jobId}-${Date.now()}`;
}

function buildProfessionalCommitMessage(input: {
  projectName: string;
  candidate?: string;
  summary?: string;
}): string {
  const fallback = `fix(deploy): resolve deployment failure for ${input.projectName}`;
  const raw = (input.candidate && input.candidate.trim()) || (input.summary && input.summary.trim()) || fallback;

  let normalized = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");

  if (!normalized) {
    normalized = fallback;
  }

  const conventionalPattern = /^(feat|fix|chore|docs|refactor|perf|test|build|ci|revert)(\([^)]+\))?:\s.+/i;
  if (!conventionalPattern.test(normalized)) {
    const lowerFirst = normalized.charAt(0).toLowerCase() + normalized.slice(1);
    normalized = `fix(deploy): ${lowerFirst}`;
  }

  if (normalized.length > 90) {
    normalized = `${normalized.slice(0, 87).trimEnd()}...`;
  }

  return normalized;
}

async function createPullRequest(input: {
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
    let deploymenterrro = latestDeploymentId
      ? await fetchDeploymentError(latestDeploymentId, runtime.vercelToken)
      : "No deployment id provided.";

    logStep(
      jobId,
      `Project metadata: projectId=${projectId} userId=${userId} latestDeploymentId=${latestDeploymentId} buildCommand=${buildCommand ?? "<none>"} installCommand=${project.installCommand ?? "<none>"} outputDirectory=${project.outputDirectory ?? "<none>"} framework=${project.framework ?? "<none>"} selectedModel=${runtime.model.provider}:${runtime.model.modelName}`
    );

    logStep(jobId, `deploymenterrro=${deploymenterrro ?? "<none>"}`);

    if (!deploymenterrro) {
      logStep(jobId, "No deployment error detected. Logging possible non-code issue and finishing.");
      console.log(
        `[fixProjectWorker][job=${jobId}] Potential non-code issue. Check build command (${buildCommand ?? "<none>"}), install command (${project.installCommand ?? "<none>"}), output directory (${project.outputDirectory ?? "<none>"}), and environment variables.`
      );
      return;
    }

    let repoDir = "";
    let branch = "main";
    let featureBranch = "";

    try {
      logStep(jobId, "Cloning linked GitHub repository");
      const cloneResult = await cloneProjectRepository(jobId, project, runtime.githubToken);
      repoDir = cloneResult.repoDir;
      branch = cloneResult.branch;
      logStep(jobId, `Repository cloned at ${repoDir}`);
      featureBranch = buildFixBranchName(projectId, jobId);
      logStep(jobId, `Creating feature branch ${featureBranch}`);

      const repoGit = simpleGit(repoDir);
      await repoGit.checkoutLocalBranch(featureBranch);

      let fixedAndValidated = false;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        logStep(jobId, `Attempt ${attempt}: preparing repository snapshot for ${runtime.model.provider}`);
        const repoSnapshot = await buildRepositorySnapshot(repoDir);
        logStep(jobId, `Attempt ${attempt}: sending repository + deploymenterrro to ${runtime.model.provider}`);

        const geminiFix = await askSelectedModelForFix({
          repoSnapshot,
          deploymenterrro,
          project,
          runtime,
        });

        const plannedChanges = geminiFix.files ?? [];
        logStep(
          jobId,
          `Attempt ${attempt}: ${runtime.model.provider} responded. summary=${geminiFix.summary ?? "<none>"}, files=${plannedChanges.length}`
        );

        if (plannedChanges.length === 0) {
          logStep(jobId, `Attempt ${attempt}: no code changes proposed by Gemini.`);
          break;
        }

        const changedCount = await applyGeminiChanges(repoDir, plannedChanges);
        logStep(jobId, `Attempt ${attempt}: applied ${changedCount} file changes from Gemini`);

        logStep(jobId, `Attempt ${attempt}: validating repository with Docker`);
        const validation = await validateWithDocker(repoDir);
        logStep(jobId, `Attempt ${attempt}: docker validation result: ok=${validation.ok} skipped=${validation.skipped ?? false}`);

        if (validation.ok) {
          fixedAndValidated = true;
          const commitMessage = buildProfessionalCommitMessage({
            projectName: project.name,
            ...(geminiFix.commitMessage ? { candidate: geminiFix.commitMessage } : {}),
            ...(geminiFix.summary ? { summary: geminiFix.summary } : {}),
          });
          logStep(jobId, "Validation passed. Checking git changes for push");
          const pushed = await pushIfChanged(repoDir, featureBranch, commitMessage);
          logStep(jobId, pushed ? `Changes pushed to GitHub on branch ${featureBranch}` : "No changes to push");

          if (pushed) {
            const owner = project.link?.org;
            const repo = project.link?.repo;
            if (owner && repo) {
              const prUrl = await createPullRequest({
                owner,
                repo,
                baseBranch: branch,
                headBranch: featureBranch,
                githubToken: runtime.githubToken,
                title: commitMessage,
                body: [
                  `Automated fix for deployment ${latestDeploymentId ?? "unknown"}.`,
                  "",
                  `Deployment error: ${deploymenterrro ?? "<none>"}`,
                  "",
                  `Validation: ${validation.details}`,
                ].join("\n"),
              });

              logStep(jobId, prUrl ? `Pull request created: ${prUrl}` : "Pull request creation returned no URL");
            } else {
              logStep(jobId, "Skipped pull request creation because repository owner/name metadata is missing.");
            }
          }
          break;
        }

        deploymenterrro = `Docker validation failed after Gemini fix. Details:\n${validation.details}`;
        logStep(jobId, `Attempt ${attempt}: validation failed; updated deploymenterrro for retry`);
      }

      if (!fixedAndValidated) {
        logStep(jobId, "Auto-fix workflow finished without a validated fix.");
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
