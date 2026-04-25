import { enqueueFixProject } from "../queue/fixProjectQueue.ts";

/**
 * Validates inputs and enqueues a fix-project job.
 * Returns the BullMQ job id.
 */
export async function fixProject(
  projectId: string,
  latestDeploymentId: string | null,
  userId?: string
): Promise<string | undefined> {
  if (!latestDeploymentId) {
    throw new Error("Invalid latestDeploymentId – cannot enqueue fix without a deployment.");
  }

  return enqueueFixProject({
    projectId,
    latestDeploymentId,
    ...(userId ? { userId } : {}),
  });
}
