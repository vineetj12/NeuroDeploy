import type { VercelProject } from "../../types.ts";

export type DeploymentEvent = {
  text?: string;
  payload?: {
    text?: string;
    info?: {
      readyState?: string;
      step?: string;
    };
  };
};

export type GeminiFileChange = {
  path: string;
  content: string;
};

export type GeminiFixResponse = {
  summary?: string;
  files?: GeminiFileChange[];
  commitMessage?: string;
};

export type DockerValidationResult = {
  ok: boolean;
  skipped?: boolean;
  details: string;
};

export type SupportedModelProvider = "GEMINI" | "ANTHROPIC" | "OPENAI" | "DEEPSEEK";

export type SelectedModelRuntime = {
  provider: SupportedModelProvider;
  modelName: string;
  apiKey: string;
};

export type WorkerRuntimeCredentials = {
  githubToken: string;
  vercelToken: string;
  model: SelectedModelRuntime;
};
