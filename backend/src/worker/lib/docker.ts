import Docker from "dockerode";
import { existsSync } from "node:fs";
import { join } from "node:path";
import tar from "tar-fs";
import type { VercelProject } from "../../types.ts";
import { runShellCommand } from "../../lib/shell.ts";
import type { DockerValidationResult } from "./types.ts";

const docker = new Docker();

export function followDockerStream(stream: NodeJS.ReadableStream): Promise<void> {
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

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function installDocker(): Promise<boolean> {
  console.log("[installDocker] Attempting to install Docker...");
  try {
    if (process.platform === "win32") {
      const result = await runShellCommand(
        "winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements",
        process.cwd(),
        300_000
      );
      console.log(`[installDocker] Windows install result: ${result.output}`);
      return result.ok;
    } else if (process.platform === "darwin") {
      const result = await runShellCommand("brew install --cask docker", process.cwd(), 300_000);
      console.log(`[installDocker] macOS install result: ${result.output}`);
      return result.ok;
    } else {
      const result = await runShellCommand(
        "curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh",
        process.cwd(),
        300_000
      );
      console.log(`[installDocker] Linux install result: ${result.output}`);
      return result.ok;
    }
  } catch (error) {
    console.error("[installDocker] Failed to install Docker:", error);
    return false;
  }
}

export async function validateWithBuildCommand(
  repoDir: string,
  project: VercelProject
): Promise<DockerValidationResult> {
  const installCmd = project.installCommand || "npm install";
  const buildCmd = project.buildCommand || "npm run build";

  console.log(`[validation] Running install: ${installCmd}`);
  const installResult = await runShellCommand(installCmd, repoDir, 120_000);
  if (!installResult.ok) {
    return {
      ok: false,
      details: `Install failed (${installCmd}):\n${installResult.output.slice(-2000)}`,
    };
  }

  console.log(`[validation] Install succeeded. Running build: ${buildCmd}`);
  const buildResult = await runShellCommand(buildCmd, repoDir, 120_000);
  if (!buildResult.ok) {
    return {
      ok: false,
      details: `Build failed (${buildCmd}):\n${buildResult.output.slice(-2000)}`,
    };
  }

  console.log("[validation] Build succeeded.");
  return { ok: true, details: `Build validation passed (${buildCmd}).` };
}

export async function validateWithDocker(
  repoDir: string,
  project?: VercelProject
): Promise<DockerValidationResult> {
  let dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    console.log("[validation] Docker not available. Attempting to install...");
    await installDocker();

    console.log("[validation] Waiting 10 seconds for Docker daemon to start...");
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.log(
        "[validation] Docker still not available after installation attempt. Falling back to build-command validation."
      );
      if (project) {
        return validateWithBuildCommand(repoDir, project);
      }
      return {
        ok: true,
        skipped: true,
        details: "Docker not available and no project metadata for build validation.",
      };
    }
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
      Tty: true,
    });
    containerId = container.id;

    await container.start();
    const result = await Promise.race([
      container.wait(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000)),
    ]);

    const logsBuffer = await container.logs({ stdout: true, stderr: true });
    // When Tty is true, Docker does not multiplex the stream. We just strip ANSI colors.
    const logs = logsBuffer.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");


    if (result === "timeout") {
      return { ok: true, details: `Container kept running for 30s. Logs:\n${logs}` };
    }

    if (typeof result?.StatusCode === "number" && result.StatusCode !== 0) {
      return { ok: false, details: `Container exited with code ${result.StatusCode}. Logs:\n${logs}` };
    }

    return { ok: true, details: `Container run completed successfully. Logs:\n${logs}` };
  } catch (error) {
    if (error instanceof Error) return { ok: false, details: error.message };
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
