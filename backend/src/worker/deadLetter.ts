const REPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeadLetterEntry {
  id: string;
  originalJobId: string;
  webhookPayload: Record<string, unknown>;
  failureReason: string;
  failureStack: string;
  attemptCount: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  canReplay: boolean;
}

export function isDeploymentStillRelevant(jobTimestamp: number | null | undefined): boolean {
  if (!jobTimestamp) return false;
  return Date.now() - jobTimestamp <= REPLAY_MAX_AGE_MS;
}
