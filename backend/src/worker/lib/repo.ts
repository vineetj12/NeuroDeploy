import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GeminiFileChange } from "./types.ts";

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

export function isProbablyTextFile(filePath: string): boolean {
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

export async function collectRepositoryFiles(rootDir: string): Promise<string[]> {
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

export async function buildRepositorySnapshot(rootDir: string): Promise<string> {
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

export function sanitizeRelativePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("../") || normalized.includes("..\\")) {
    throw new Error(`Unsafe file path from model: ${filePath}`);
  }
  return normalized;
}

export async function applyGeminiChanges(repoDir: string, changes: GeminiFileChange[]): Promise<number> {
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
