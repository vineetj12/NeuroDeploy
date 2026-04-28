import { prisma } from "../../PrismaClientManager/index.ts";
import { GEMINI_API_KEY, GEMINI_MODEL } from "../../envdata/data.ts";
import { asSupportedProvider } from "./ai.ts";
import type { SelectedModelRuntime, WorkerRuntimeCredentials } from "./types.ts";

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
    // If the user selected a model but doesn't have a stored key, fall back to GEMINI env key
    if (GEMINI_API_KEY && GEMINI_API_KEY.trim() !== "") {
      return {
        provider: "GEMINI",
        modelName: GEMINI_MODEL,
        apiKey: GEMINI_API_KEY,
      };
    }

    throw new Error(`API key missing for selected model ${user.selectedModel.name}.`);
  }

  return {
    provider,
    modelName: user.selectedModel.name,
    apiKey: modelKey.apiKey,
  };
}

export async function loadWorkerRuntimeCredentials(userId: string): Promise<WorkerRuntimeCredentials> {
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

export function getSafeEnvSnapshot(runtime: WorkerRuntimeCredentials): string {
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
