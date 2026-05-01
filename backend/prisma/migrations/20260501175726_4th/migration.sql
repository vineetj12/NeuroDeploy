-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "originalJobId" TEXT NOT NULL,
    "userId" TEXT,
    "webhookPayload" JSONB NOT NULL,
    "failureReason" TEXT NOT NULL,
    "failureStack" TEXT,
    "attemptCount" INTEGER NOT NULL,
    "canReplay" BOOLEAN NOT NULL DEFAULT true,
    "replayedAt" TIMESTAMP(3),
    "replayJobId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeadLetterJob_userId_idx" ON "DeadLetterJob"("userId");

-- CreateIndex
CREATE INDEX "DeadLetterJob_userId_dismissedAt_idx" ON "DeadLetterJob"("userId", "dismissedAt");

-- CreateIndex
CREATE INDEX "DeadLetterJob_originalJobId_idx" ON "DeadLetterJob"("originalJobId");

-- AddForeignKey
ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
