import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

const LOCK_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const LOCK_PREFIX = "neurodeploy:lock:repo:";

export class LockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockConflictError";
  }
}

export class LockStolenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockStolenError";
  }
}

export class DistributedRepoLock {
  private lockId = randomUUID();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private acquired = false;
  private lockError: Error | null = null;

  constructor(
    private redis: Redis,
    private repoFullName: string
  ) {}

  private get key(): string {
    return `${LOCK_PREFIX}${this.repoFullName}`;
  }

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(this.key, this.lockId, "PX", LOCK_TTL_MS, "NX");

    if (result !== "OK") {
      const ttl = await this.redis.pttl(this.key);
      const retrySeconds = ttl > 0 ? Math.ceil(ttl / 1000) : 60;
      throw new LockConflictError(
        `Repo ${this.repoFullName} is being processed by another worker. Retry in ${retrySeconds}s`
      );
    }

    this.acquired = true;
    this.startHeartbeat();
    return true;
  }

  assertActive(): void {
    if (this.lockError) {
      throw this.lockError;
    }
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.acquired) return;

    const script = [
      "if redis.call(\"get\", KEYS[1]) == ARGV[1] then",
      "  return redis.call(\"del\", KEYS[1])",
      "else",
      "  return 0",
      "end",
    ].join("\n");

    await this.redis.eval(script, 1, this.key, this.lockId);
    this.acquired = false;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.renew().catch((error) => {
        this.lockError = error instanceof Error ? error : new Error(String(error));
        this.stopHeartbeat();
      });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async renew(): Promise<void> {
    if (!this.acquired) return;

    const script = [
      "if redis.call(\"get\", KEYS[1]) == ARGV[1] then",
      "  return redis.call(\"pexpire\", KEYS[1], ARGV[2])",
      "else",
      "  return 0",
      "end",
    ].join("\n");

    const result = await this.redis.eval(script, 1, this.key, this.lockId, String(LOCK_TTL_MS));
    if (result !== 1) {
      this.lockError = new LockStolenError(`Lock for ${this.repoFullName} was taken by another process`);
      this.stopHeartbeat();
    }
  }
}
