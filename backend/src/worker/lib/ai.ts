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
    "Return ONLY valid JSON. No markdown fences, no commentary outside the JSON.",
    "",
    "Required JSON schema:",
    "{",
    '  "summary": "short one-line summary of what you fixed",',
    '  "commitMessage": "fix: concise conventional commit message",',
    '  "overallSummary": "A detailed human-readable paragraph explaining the root cause of the deployment failure, the overall fix strategy, and any important context a reviewer should know.",',
    '  "estimatedRiskLevel": "LOW | MEDIUM | HIGH — estimate the risk of this change breaking something else",',
    '  "files": [',
    "    {",
    '      "path": "relative/path/to/file",',
    '      "content": "full corrected file content",',
    '      "rootCause": "Concise explanation of what caused the failure in this file (e.g. Missing null check on req.body.user)",',
    '      "fixStrategy": "Concise explanation of what you changed and why (e.g. Added optional chaining + fallback default)",',
    '      "confidenceScore": 0.95,  // 0.0 to 1.0 — how confident you are this fix is correct',
    '      "alternativesConsidered": ["brief description of alternative approach 1", "brief description of alternative approach 2"]',
    "    }",
    "  ]",
    "}",
    "",
    "IMPORTANT INSTRUCTIONS for explainability fields:",
    "- rootCause: Be specific about the exact bug or misconfiguration. Reference variable names, line logic, or missing dependencies.",
    "- fixStrategy: Explain the technique used (e.g. 'added missing import', 'upgraded dependency version', 'fixed tsconfig path').",
    "- confidenceScore: Use 0.9+ for straightforward fixes, 0.5-0.8 for educated guesses, below 0.5 for speculative changes.",
    "- alternativesConsidered: List 1-3 other approaches you considered but rejected, and briefly say why.",
    "- overallSummary: Write 2-4 sentences a developer can read to understand the full picture without reading the diff.",
    "- estimatedRiskLevel: LOW = isolated fix, MEDIUM = touches shared code, HIGH = structural or dependency change.",
    "",
    "If no code change is needed, return files as an empty array and explain in summary and overallSummary.",
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
