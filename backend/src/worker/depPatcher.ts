import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import axios from "axios";
import { runShellCommand } from "../lib/shell.ts";

export interface VulnerabilityReport {
  packageName: string;
  installedVersion: string;
  severity: "critical" | "high" | "medium" | "low";
  fixedInVersion: string;
  cve: string;
  description: string;
}

const AUDIT_TIMEOUT_MS = 120_000;

export async function auditDependencies(repoPath: string): Promise<VulnerabilityReport[]> {
  const auditOutput = await runShellCommand("npm audit --json", repoPath, AUDIT_TIMEOUT_MS);
  const audit = parseAuditJson(auditOutput.output);

  if (!audit) {
    return [];
  }

  const reports: VulnerabilityReport[] = [];
  const vulnerabilities = audit.vulnerabilities as Record<string, any> | undefined;

  if (vulnerabilities) {
    for (const [name, vuln] of Object.entries(vulnerabilities)) {
      const fixAvailable = vuln?.fixAvailable;
      if (!fixAvailable || fixAvailable === true || !fixAvailable.version) {
        continue;
      }

      const installedVersion =
        (await getInstalledVersionFromLock(repoPath, name)) ||
        coerceVersion(vuln?.installedVersion) ||
        coerceVersion(vuln?.range) ||
        "unknown";

      const viaEntry = Array.isArray(vuln?.via) ? vuln.via.find((entry: any) => typeof entry === "object") : null;
      reports.push({
        packageName: name,
        installedVersion,
        severity: vuln?.severity ?? "low",
        fixedInVersion: fixAvailable.version,
        cve: viaEntry?.url ?? "",
        description: viaEntry?.title ?? vuln?.name ?? name,
      });
    }

    return reports.filter((report) => report.severity === "critical" || report.severity === "high");
  }

  const advisories = audit.advisories as Record<string, any> | undefined;
  if (advisories) {
    for (const advisory of Object.values(advisories)) {
      const name = advisory?.module_name;
      const fixedIn = advisory?.patched_versions;
      if (!name || !fixedIn || fixedIn === "<0.0.0") continue;

      const minFixed = semver.minVersion(fixedIn)?.version;
      if (!minFixed) continue;

      const installedVersion =
        (await getInstalledVersionFromLock(repoPath, name)) ||
        coerceVersion(advisory?.findings?.[0]?.version) ||
        "unknown";

      reports.push({
        packageName: name,
        installedVersion,
        severity: advisory?.severity ?? "low",
        fixedInVersion: minFixed,
        cve: advisory?.url ?? "",
        description: advisory?.title ?? name,
      });
    }
  }

  return reports.filter((report) => report.severity === "critical" || report.severity === "high");
}

export async function findSafeUpgradeVersion(
  packageName: string,
  currentVersion: string,
  minimumSafeVersion: string,
  peerConstraints: Record<string, string[]>
): Promise<string | null> {
  const cleanedMinimum = semver.clean(minimumSafeVersion) ?? minimumSafeVersion;

  if (semver.valid(currentVersion) && semver.gte(currentVersion, cleanedMinimum)) {
    if (satisfiesPeerConstraints(currentVersion, peerConstraints[packageName])) {
      return currentVersion;
    }
  }

  const { data } = await axios.get(`https://registry.npmjs.org/${packageName}`);
  const allVersions = Object.keys(data.versions ?? {}).filter((version) => semver.valid(version));

  const candidates = allVersions
    .filter((version) => !semver.prerelease(version))
    .filter((version) => semver.gte(version, cleanedMinimum))
    .filter((version) => satisfiesPeerConstraints(version, peerConstraints[packageName]))
    .sort(semver.compare);

  return candidates[0] ?? null;
}

export async function patchPackageJson(
  repoPath: string,
  upgrades: Array<{ name: string; from: string; to: string }>
): Promise<void> {
  const pkgPath = path.join(repoPath, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));

  for (const { name, to } of upgrades) {
    if (pkg.dependencies?.[name]) pkg.dependencies[name] = `^${to}`;
    if (pkg.devDependencies?.[name]) pkg.devDependencies[name] = `^${to}`;
    if (pkg.optionalDependencies?.[name]) pkg.optionalDependencies[name] = `^${to}`;
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  await runShellCommand("npm install --package-lock-only", repoPath, AUDIT_TIMEOUT_MS);
}

export async function buildPeerConstraintMap(repoPath: string): Promise<Record<string, string[]>> {
  const lockPath = path.join(repoPath, "package-lock.json");
  const constraints: Record<string, Set<string>> = {};

  let lockRaw: string;
  try {
    lockRaw = await readFile(lockPath, "utf8");
  } catch {
    return {};
  }

  let lockJson: any;
  try {
    lockJson = JSON.parse(lockRaw);
  } catch {
    return {};
  }

  if (lockJson?.packages && typeof lockJson.packages === "object") {
    for (const pkg of Object.values(lockJson.packages)) {
      if (!pkg || typeof pkg !== "object") continue;
      const peerDeps = pkg.peerDependencies ?? {};
      const peerMeta = pkg.peerDependenciesMeta ?? {};

      for (const [peerName, range] of Object.entries(peerDeps)) {
        const meta = peerMeta[peerName];
        if (meta?.optional) continue;
        if (!constraints[peerName]) constraints[peerName] = new Set();
        if (typeof range === "string") {
          constraints[peerName].add(range);
        }
      }
    }
  } else if (lockJson?.dependencies && typeof lockJson.dependencies === "object") {
    collectPeerConstraintsFromTree(lockJson.dependencies, constraints);
  }

  const result: Record<string, string[]> = {};
  for (const [name, ranges] of Object.entries(constraints)) {
    result[name] = Array.from(ranges);
  }

  return result;
}

function collectPeerConstraintsFromTree(tree: Record<string, any>, constraints: Record<string, Set<string>>): void {
  for (const pkg of Object.values(tree)) {
    if (!pkg || typeof pkg !== "object") continue;

    const peerDeps = pkg.peerDependencies ?? {};
    const peerMeta = pkg.peerDependenciesMeta ?? {};

    for (const [peerName, range] of Object.entries(peerDeps)) {
      const meta = peerMeta[peerName];
      if (meta?.optional) continue;
      if (!constraints[peerName]) constraints[peerName] = new Set();
      if (typeof range === "string") {
        constraints[peerName].add(range);
      }
    }

    if (pkg.dependencies) {
      collectPeerConstraintsFromTree(pkg.dependencies, constraints);
    }
  }
}

function parseAuditJson(output: string): any | null {
  if (!output) return null;
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(output.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function satisfiesPeerConstraints(version: string, ranges: string[] | undefined): boolean {
  if (!ranges || ranges.length === 0) return true;
  return ranges.every((range) => {
    if (!range || typeof range !== "string") return false;
    return semver.satisfies(version, range, { includePrerelease: false });
  });
}

async function getInstalledVersionFromLock(repoPath: string, packageName: string): Promise<string | null> {
  const lockPath = path.join(repoPath, "package-lock.json");

  let lockRaw: string;
  try {
    lockRaw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }

  let lockJson: any;
  try {
    lockJson = JSON.parse(lockRaw);
  } catch {
    return null;
  }

  if (lockJson?.packages && typeof lockJson.packages === "object") {
    const entry = lockJson.packages[`node_modules/${packageName}`];
    if (entry?.version) return entry.version;
  }

  if (lockJson?.dependencies && typeof lockJson.dependencies === "object") {
    return findVersionInTree(lockJson.dependencies, packageName);
  }

  return null;
}

function findVersionInTree(tree: Record<string, any>, packageName: string): string | null {
  const candidate = tree[packageName];
  if (candidate?.version) return candidate.version;

  for (const pkg of Object.values(tree)) {
    if (pkg?.dependencies) {
      const found = findVersionInTree(pkg.dependencies, packageName);
      if (found) return found;
    }
  }

  return null;
}

function coerceVersion(value: string | undefined): string | null {
  if (!value) return null;
  const coerced = semver.coerce(value);
  return coerced?.version ?? null;
}
