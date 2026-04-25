import { enqueueFixProject } from "../../../queue/fixProjectQueue.ts";
import { fetchProjectById } from "../vercel.ts";
import { getLatestDeployment } from "./extractors.ts";

const ACTIVE_MONITORS = new Set<string>();
const MAX_MONITOR_ATTEMPTS = 30;
const MONITOR_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the Vercel API until the deployment reaches a final state (READY / ERROR).
 * Automatically enqueues a fix job when ERROR is detected.
 * No-ops if a monitor for the same key is already running.
 */
export async function monitorDeploymentUntilFinal(
  projectId: string,
  deploymentId: string | null,
  context: string
): Promise<void> {
  const monitorKey = `${projectId}:${deploymentId ?? "latest"}`;
  if (ACTIVE_MONITORS.has(monitorKey)) return;

  ACTIVE_MONITORS.add(monitorKey);

  try {
    for (let attempt = 1; attempt <= MAX_MONITOR_ATTEMPTS; attempt += 1) {
      const project = await fetchProjectById(projectId);
      const deployment = getLatestDeployment(project, deploymentId);
      const readyState = deployment?.readyState ?? null;

      console.log(
        `[webhook] monitor ${context} project=${projectId} deployment=${
          deployment?.id ?? deploymentId ?? "<none>"
        } attempt=${attempt} readyState=${readyState ?? "<unknown>"}`
      );

      if (readyState === "READY") return;

      if (readyState === "ERROR") {
        if (deployment?.id) {
          await enqueueFixProject({
            projectId,
            latestDeploymentId: deployment.id,
          });
        }
        return;
      }

      if (attempt < MAX_MONITOR_ATTEMPTS) {
        await sleep(MONITOR_DELAY_MS);
      }
    }
  } catch (error) {
    console.error(`[webhook] monitor failed for ${monitorKey}:`, error);
  } finally {
    ACTIVE_MONITORS.delete(monitorKey);
  }
}
