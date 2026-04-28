import { prisma } from "../PrismaClientManager/index.ts";
import type { ErrorCategoryType } from "./errorClassifier.ts";

export interface CreateFixJobInput {
  userId: string;
  projectId: string;
  projectName?: string | undefined;
  deploymentId?: string | undefined;
  bullmqJobId?: string | undefined;
  errorCategory?: ErrorCategoryType | undefined;
  errorMessage?: string | undefined;
  aiProvider?: string | undefined;
  aiModel?: string | undefined;
}

export interface CompleteFixJobInput {
  status: "PR_CREATED" | "FAILED";
  prUrl?: string | null | undefined;
  confidenceScore?: number | null | undefined;
  riskLevel?: string | null | undefined;
  filesChanged?: number | undefined;
  fixedFiles?: string[] | undefined;
  durationMs?: number | undefined;
}

export async function createFixJob(data: CreateFixJobInput) {
  return prisma.fixJob.create({
    data: {
      userId: data.userId,
      projectId: data.projectId,
      projectName: data.projectName ?? null,
      deploymentId: data.deploymentId ?? null,
      bullmqJobId: data.bullmqJobId ?? null,
      status: "QUEUED",
      errorCategory: (data.errorCategory as any) ?? "UNKNOWN",
      errorMessage: data.errorMessage ?? null,
      aiProvider: data.aiProvider ?? null,
      aiModel: data.aiModel ?? null,
      startedAt: new Date(),
    },
  });
}

export async function updateFixJobStatus(
  fixJobId: string,
  status: "ANALYZING" | "VALIDATING",
  extras?: {
    aiProvider?: string | undefined;
    aiModel?: string | undefined;
    errorCategory?: ErrorCategoryType | undefined;
    errorMessage?: string | undefined;
  }
) {
  return prisma.fixJob.update({
    where: { id: fixJobId },
    data: {
      status: status as any,
      ...(extras?.aiProvider ? { aiProvider: extras.aiProvider } : {}),
      ...(extras?.aiModel ? { aiModel: extras.aiModel } : {}),
      ...(extras?.errorCategory ? { errorCategory: extras.errorCategory as any } : {}),
      ...(extras?.errorMessage ? { errorMessage: extras.errorMessage } : {}),
    },
  });
}

export async function completeFixJob(fixJobId: string, data: CompleteFixJobInput) {
  return prisma.fixJob.update({
    where: { id: fixJobId },
    data: {
      status: data.status as any,
      prUrl: data.prUrl ?? null,
      confidenceScore: data.confidenceScore ?? null,
      riskLevel: data.riskLevel ?? null,
      filesChanged: data.filesChanged ?? 0,
      fixedFiles: data.fixedFiles ?? [],
      durationMs: data.durationMs ?? null,
      completedAt: new Date(),
    },
  });
}

/**
 * Fetches analytics summary for a user.
 */
export async function getAnalyticsSummary(userId: string) {
  const [statusCounts, avgDuration, topErrors, providerStats, totalCount] = await Promise.all([
    prisma.fixJob.groupBy({
      by: ["status"],
      where: { userId },
      _count: { id: true },
    }),
    prisma.fixJob.aggregate({
      where: { userId, status: "PR_CREATED" as any },
      _avg: { durationMs: true, confidenceScore: true },
    }),
    prisma.fixJob.groupBy({
      by: ["errorCategory"],
      where: { userId },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    }),
    prisma.fixJob.groupBy({
      by: ["aiProvider"],
      where: { userId, aiProvider: { not: null } },
      _count: { id: true },
      _avg: { durationMs: true, confidenceScore: true },
    }),
    prisma.fixJob.count({ where: { userId } }),
  ]);

  const successCount = statusCounts.find((s) => s.status === "PR_CREATED")?._count?.id ?? 0;
  const failedCount = statusCounts.find((s) => s.status === "FAILED")?._count?.id ?? 0;
  const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

  return {
    totalJobs: totalCount,
    successCount,
    failedCount,
    successRate,
    avgFixTimeMs: Math.round(avgDuration._avg?.durationMs ?? 0),
    avgConfidence: Math.round((avgDuration._avg?.confidenceScore ?? 0) * 100),
    statusCounts: statusCounts.map((s) => ({
      status: s.status,
      count: s._count.id,
    })),
    topErrors: topErrors.map((e) => ({
      category: e.errorCategory,
      count: e._count.id,
    })),
    providerStats: providerStats.map((p) => ({
      provider: p.aiProvider,
      jobCount: p._count.id,
      avgDurationMs: Math.round(p._avg?.durationMs ?? 0),
      avgConfidence: Math.round((p._avg?.confidenceScore ?? 0) * 100),
    })),
  };
}

/**
 * Daily success/fail timeline for the last N days.
 */
export async function getAnalyticsTimeline(userId: string, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const jobs = await prisma.fixJob.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Group by date
  const dailyMap = new Map<string, { success: number; failed: number; total: number }>();

  // Pre-fill all days
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toISOString().split("T")[0]!;
    dailyMap.set(key, { success: 0, failed: 0, total: 0 });
  }

  for (const job of jobs) {
    const key = job.createdAt.toISOString().split("T")[0]!;
    const entry = dailyMap.get(key);
    if (entry) {
      entry.total += 1;
      if (job.status === "PR_CREATED") entry.success += 1;
      if (job.status === "FAILED") entry.failed += 1;
    }
  }

  return Array.from(dailyMap.entries()).map(([date, data]) => ({
    date,
    ...data,
    successRate: data.total > 0 ? Math.round((data.success / data.total) * 100) : 0,
  }));
}

/**
 * Top most-frequently fixed files.
 */
export async function getAnalyticsFiles(userId: string, limit = 20) {
  const jobs = await prisma.fixJob.findMany({
    where: { userId, status: "PR_CREATED" as any, fixedFiles: { isEmpty: false } },
    select: { fixedFiles: true },
  });

  const fileCounts = new Map<string, number>();
  for (const job of jobs) {
    for (const file of job.fixedFiles) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }

  return Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}
