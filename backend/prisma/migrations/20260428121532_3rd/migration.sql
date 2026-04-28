-- CreateEnum
CREATE TYPE "FixJobStatus" AS ENUM ('QUEUED', 'ANALYZING', 'VALIDATING', 'PR_CREATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('BUILD_ERROR', 'TYPE_ERROR', 'SYNTAX_ERROR', 'MISSING_DEPENDENCY', 'MISSING_ENV_VAR', 'CONFIG_ERROR', 'DEPENDENCY_CONFLICT', 'RUNTIME_ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "FixJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectName" TEXT,
    "deploymentId" TEXT,
    "bullmqJobId" TEXT,
    "status" "FixJobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCategory" "ErrorCategory" NOT NULL DEFAULT 'UNKNOWN',
    "errorMessage" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "riskLevel" TEXT,
    "durationMs" INTEGER,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "fixedFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixJob_userId_idx" ON "FixJob"("userId");

-- CreateIndex
CREATE INDEX "FixJob_userId_status_idx" ON "FixJob"("userId", "status");

-- CreateIndex
CREATE INDEX "FixJob_userId_createdAt_idx" ON "FixJob"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "FixJob" ADD CONSTRAINT "FixJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
