/*
  Warnings:

  - A unique constraint covering the columns `[modelId]` on the table `UserModelKey` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "AIModel" ADD COLUMN     "isSelected" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "UserModelKey_modelId_key" ON "UserModelKey"("modelId");
