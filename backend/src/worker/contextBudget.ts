import { readFile } from "node:fs/promises";
import path from "node:path";
import { encode } from "gpt-tokenizer";
import { collectRepositoryFiles } from "./lib/repo.ts";

const MODEL_BUDGETS: Record<string, number> = {
  "gemini-2.5-flash": 900_000,
  "gpt-4o": 120_000,
  "claude-sonnet-4-20250514": 180_000,
};

const RESERVED_FOR_OUTPUT = 8_000;
const RESERVED_FOR_PROMPT = 2_000;
const RESERVED_FOR_ERROR_LOG = 4_000;

const TOKEN_BUCKET_SIZE = 200;
const MIN_TRUNCATED_TOKENS = 400;
const JS_LIKE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export interface DeploymentDiff {
  changedFiles: Array<{ filename: string }>;
}

export interface RankedFile {
  path: string;
  content: string;
  relevanceScore: number;
  tokenCount: number;
  inclusionReason: string;
}

export async function buildContextBudget(
  repoPath: string,
  errorLog: string,
  deploymentDiff: DeploymentDiff,
  model: string
): Promise<RankedFile[]> {
  const totalBudget = MODEL_BUDGETS[model] ?? 120_000;
  const availableForFiles = Math.max(
    0,
    totalBudget - RESERVED_FOR_OUTPUT - RESERVED_FOR_PROMPT - RESERVED_FOR_ERROR_LOG
  );

  const allFiles = await getAllCodeFiles(repoPath);
  if (availableForFiles === 0 || allFiles.length === 0) {
    return [];
  }

  const scored: RankedFile[] = [];

  for (const filePath of allFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const relativePath = path.relative(repoPath, filePath).replace(/\\/g, "/");
    const tokenCount = estimateTokens(content);
    const relevanceScore = computeRelevanceScore(relativePath, content, errorLog, deploymentDiff);

    scored.push({
      path: relativePath,
      content,
      relevanceScore,
      tokenCount,
      inclusionReason: explainRelevance(relativePath, errorLog, deploymentDiff),
    });
  }

  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return a.tokenCount - b.tokenCount;
  });

  const selected = selectWithKnapsack(scored, availableForFiles);
  return enforceBudgetWithTruncation(selected, availableForFiles);
}

function estimateTokens(text: string): number {
  return encode(text).length;
}

async function getAllCodeFiles(repoPath: string): Promise<string[]> {
  const relativeFiles = await collectRepositoryFiles(repoPath);
  return relativeFiles.map((relPath) => path.join(repoPath, relPath));
}

function selectWithKnapsack(files: RankedFile[], tokenBudget: number): RankedFile[] {
  const budgetWeight = Math.max(1, Math.floor(tokenBudget / TOKEN_BUCKET_SIZE));
  const bestValue = Array<number>(budgetWeight + 1).fill(Number.NEGATIVE_INFINITY);
  const choiceIndex = Array<number>(budgetWeight + 1).fill(-1);
  const choicePrevWeight = Array<number>(budgetWeight + 1).fill(-1);

  bestValue[0] = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const weight = Math.max(1, Math.ceil(file.tokenCount / TOKEN_BUCKET_SIZE));

    for (let w = budgetWeight; w >= weight; w -= 1) {
      const prev = bestValue[w - weight];
      if (prev === Number.NEGATIVE_INFINITY) continue;
      const candidateValue = prev + file.relevanceScore;
      if (candidateValue > bestValue[w]) {
        bestValue[w] = candidateValue;
        choiceIndex[w] = i;
        choicePrevWeight[w] = w - weight;
      }
    }
  }

  let bestWeight = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let w = 0; w <= budgetWeight; w += 1) {
    if (bestValue[w] > bestScore) {
      bestScore = bestValue[w];
      bestWeight = w;
    }
  }

  const selectedIndices = new Set<number>();
  let w = bestWeight;
  while (w > 0 && choiceIndex[w] !== -1) {
    const index = choiceIndex[w];
    if (selectedIndices.has(index)) break;
    selectedIndices.add(index);
    w = choicePrevWeight[w];
  }

  return files.filter((_, index) => selectedIndices.has(index));
}

function enforceBudgetWithTruncation(files: RankedFile[], tokenBudget: number): RankedFile[] {
  const selected = [...files];
  let usedTokens = selected.reduce((sum, file) => sum + file.tokenCount, 0);

  if (usedTokens <= tokenBudget) {
    return selected;
  }

  const truncationCandidates = selected
    .filter((file) => file.tokenCount > MIN_TRUNCATED_TOKENS && file.relevanceScore >= 0.6)
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      return b.tokenCount - a.tokenCount;
    });

  for (const file of truncationCandidates) {
    if (usedTokens <= tokenBudget) break;
    const overage = usedTokens - tokenBudget;
    const targetTokens = Math.max(MIN_TRUNCATED_TOKENS, file.tokenCount - overage);

    const truncatedContent = truncateToTokenBudget(file.content, targetTokens, file.path);
    const truncatedTokens = estimateTokens(truncatedContent);

    if (truncatedTokens < file.tokenCount) {
      usedTokens -= file.tokenCount - truncatedTokens;
      file.content = truncatedContent;
      file.tokenCount = truncatedTokens;
      file.inclusionReason = `${file.inclusionReason} [TRUNCATED]`;
    }
  }

  if (usedTokens <= tokenBudget) {
    return selected;
  }

  selected.sort((a, b) => {
    const densityA = a.relevanceScore / Math.max(1, a.tokenCount);
    const densityB = b.relevanceScore / Math.max(1, b.tokenCount);
    if (densityA !== densityB) return densityA - densityB;
    return a.relevanceScore - b.relevanceScore;
  });

  while (usedTokens > tokenBudget && selected.length > 0) {
    const dropped = selected.shift();
    if (!dropped) break;
    usedTokens -= dropped.tokenCount;
  }

  return selected;
}

function truncateToTokenBudget(content: string, tokenBudget: number, filePath: string): string {
  if (tokenBudget <= 0) return "";
  if (estimateTokens(content) <= tokenBudget) return content;

  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    const truncatedJson = truncateJsonToTokenBudget(content, tokenBudget);
    if (truncatedJson) return truncatedJson;
  }

  if (JS_LIKE_EXTENSIONS.has(extension)) {
    return truncateJsLikeToTokenBudget(content, tokenBudget);
  }

  return truncatePlainTextToTokenBudget(content, tokenBudget);
}

function truncatePlainTextToTokenBudget(content: string, tokenBudget: number): string {
  const lines = content.split(/\r?\n/);
  let low = 1;
  let high = lines.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = lines.slice(0, mid).join("\n");
    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best.trimEnd();
}

function truncateJsLikeToTokenBudget(content: string, tokenBudget: number): string {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  let headLines = Math.max(1, Math.floor(totalLines * 0.6));
  let tailLines = Math.max(0, Math.floor(totalLines * 0.2));

  let best = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = balanceJsLikeBraces(
      buildHeadTailExcerpt(lines, headLines, tailLines)
    );

    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate;
      break;
    }

    const fitted = fitHeadTailToBudget(lines, headLines, tailLines, tokenBudget);
    if (fitted) {
      best = fitted;
      break;
    }

    headLines = Math.max(1, Math.floor(headLines * 0.7));
    tailLines = Math.max(0, Math.floor(tailLines * 0.7));
  }

  if (!best) {
    best = balanceJsLikeBraces(truncatePlainTextToTokenBudget(content, tokenBudget));
  }

  return best.trimEnd();
}

function buildHeadTailExcerpt(lines: string[], headLines: number, tailLines: number): string {
  const clampedHead = Math.min(lines.length, Math.max(1, headLines));
  const clampedTail = Math.min(lines.length - clampedHead, Math.max(0, tailLines));
  const head = lines.slice(0, clampedHead).join("\n");
  const tail = clampedTail > 0 ? lines.slice(lines.length - clampedTail).join("\n") : "";

  if (!tail || clampedHead + clampedTail >= lines.length) {
    return head;
  }

  return `${head}\n\n/* ... TRUNCATED ... */\n\n${tail}`;
}

function fitHeadTailToBudget(
  lines: string[],
  headLines: number,
  tailLines: number,
  tokenBudget: number
): string | null {
  let low = 0;
  let high = tailLines;
  let best: string | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = balanceJsLikeBraces(buildHeadTailExcerpt(lines, headLines, mid));

    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best) return best;

  const headOnly = balanceJsLikeBraces(buildHeadTailExcerpt(lines, Math.max(1, Math.floor(headLines * 0.5)), 0));
  if (estimateTokens(headOnly) <= tokenBudget) {
    return headOnly;
  }

  return null;
}

function balanceJsLikeBraces(text: string): string {
  const stack: string[] = [];
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{" || char === "(" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === ")" || char === "]") {
      const last = stack[stack.length - 1];
      if (last && isMatchingPair(last, char)) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return text;

  const closing = stack
    .reverse()
    .map((open) => {
      if (open === "{") return "}";
      if (open === "(") return ")";
      return "]";
    })
    .join("");

  return `${text}\n${closing}`;
}

function isMatchingPair(open: string, close: string): boolean {
  return (
    (open === "{" && close === "}") ||
    (open === "(" && close === ")") ||
    (open === "[" && close === "]")
  );
}

function truncateJsonToTokenBudget(content: string, tokenBudget: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  if (Array.isArray(parsed)) {
    const result: unknown[] = [];
    for (const entry of parsed) {
      result.push(entry);
      if (estimateTokens(JSON.stringify(result, null, 2)) > tokenBudget) {
        result.pop();
        break;
      }
    }
    const candidate = JSON.stringify(result, null, 2);
    return estimateTokens(candidate) <= tokenBudget ? candidate : null;
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  const truncated: Record<string, unknown> = {};

  for (const key of keys) {
    truncated[key] = obj[key];
    if (estimateTokens(JSON.stringify(truncated, null, 2)) > tokenBudget) {
      delete truncated[key];
      break;
    }
  }

  const candidate = JSON.stringify(truncated, null, 2);
  return estimateTokens(candidate) <= tokenBudget ? candidate : null;
}

function computeRelevanceScore(
  filePath: string,
  content: string,
  errorLog: string,
  diff: DeploymentDiff
): number {
  let score = 0;
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (diff?.changedFiles?.some((file) => normalizePath(file.filename) === normalizedPath)) {
    score += 0.5;
  }

  const basename = path.basename(filePath, path.extname(filePath));
  if (errorLog.includes(basename) || errorLog.includes(normalizedPath)) {
    score += 0.3;
  }

  if (["index.ts", "server.ts", "app.ts", "main.ts"].includes(path.basename(filePath))) {
    score += 0.15;
  }

  if (errorLog.includes(normalizedPath)) {
    score += 0.4;
  }

  if (filePath.includes(".test.") || filePath.includes(".spec.") || filePath.includes("generated")) {
    score -= 0.3;
  }

  if (content.includes("FIXME") || content.includes("TODO")) {
    score += 0.05;
  }

  return Math.min(1, Math.max(0, score));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function explainRelevance(filePath: string, errorLog: string, diff: DeploymentDiff): string {
  const reasons: string[] = [];
  const normalizedPath = normalizePath(filePath);

  if (diff?.changedFiles?.some((file) => normalizePath(file.filename) === normalizedPath)) {
    reasons.push("Changed in deployment diff");
  }

  const basename = path.basename(filePath, path.extname(filePath));
  if (errorLog.includes(basename) || errorLog.includes(normalizedPath)) {
    reasons.push("Mentioned in error log");
  }

  if (["index.ts", "server.ts", "app.ts", "main.ts"].includes(path.basename(filePath))) {
    reasons.push("Entry point file");
  }

  if (filePath.includes(".test.") || filePath.includes(".spec.")) {
    reasons.push("Test file (penalized)");
  }

  if (filePath.includes("generated")) {
    reasons.push("Generated file (penalized)");
  }

  if (reasons.length === 0) {
    reasons.push("Default relevance");
  }

  return reasons.join("; ");
}
