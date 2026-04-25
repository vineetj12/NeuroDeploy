import axios from "axios";
import type { VercelProject } from "../../types.ts";
import type { GeminiFixResponse, SelectedModelRuntime, SupportedModelProvider, WorkerRuntimeCredentials } from "./types.ts";
import { getSafeEnvSnapshot } from "./credentials.ts";

export function asSupportedProvider(value: string): SupportedModelProvider | null {
  if (value === "GEMINI" || value === "ANTHROPIC" || value === "OPENAI" || value === "DEEPSEEK") {
    return value;
  }
  return null;
}

export function extractJsonObject(text: string): string | null {
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

export function buildFixPrompt(input: {
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

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  baseDelayMs = 3000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : null;
      const isTransient = status === 503 || status === 429 || status === 500 || status === 502;

      if (!isTransient || attempt === maxRetries) {
        console.error(`[retryWithBackoff] ${label} failed after ${attempt} attempt(s). status=${status}`);
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`[retryWithBackoff] ${label} got ${status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${label}: exhausted retries`);
}

async function askGeminiForFix(prompt: string, model: SelectedModelRuntime): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.modelName)}:generateContent`;

  const response = await retryWithBackoff(
    () => axios.post(
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
    ),
    "askGeminiForFix"
  );

  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function askOpenAICompatibleForFix(input: {
  prompt: string;
  model: SelectedModelRuntime;
  baseUrl: string;
}): Promise<string> {
  const response = await retryWithBackoff(
    () => axios.post(
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
    ),
    "askOpenAICompatibleForFix"
  );

  return response.data?.choices?.[0]?.message?.content ?? "";
}

async function askAnthropicForFix(prompt: string, model: SelectedModelRuntime): Promise<string> {
  const response = await retryWithBackoff(
    () => axios.post(
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
    ),
    "askAnthropicForFix"
  );

  const parts = response.data?.content;
  if (!Array.isArray(parts)) {
    return "";
  }

  const textPart = parts.find((part: { type?: string; text?: string }) => part?.type === "text");
  return textPart?.text ?? "";
}

export async function askSelectedModelForFix(input: {
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
