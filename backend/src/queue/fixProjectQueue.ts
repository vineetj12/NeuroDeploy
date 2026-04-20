import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REDIS_URL } from "../envdata/data.js";

export const FIX_PROJECT_QUEUE_NAME = "fix-project-queue";

export type FixProjectJobData = {
  projectId: string;
  latestDeploymentId: string;
  userId?: string;
};

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const fixProjectQueue = new Queue<FixProjectJobData>(FIX_PROJECT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: 100,
    removeOnFail: 1000,
  },
});

export async function enqueueFixProject(data: FixProjectJobData): Promise<string | undefined> {
  const job = await fixProjectQueue.add("fix-project", data);
  return job.id;
}
