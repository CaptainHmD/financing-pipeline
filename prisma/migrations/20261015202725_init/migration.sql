-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('submitted', 'verifying', 'decided');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('approved_for_risk_assessment', 'rejected', 'requires_manual_compliance_review');

-- CreateEnum
CREATE TYPE "CheckType" AS ENUM ('identity', 'commercial_registration', 'credit');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('pending', 'retrying', 'verified', 'failed', 'ambiguous', 'unavailable');

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "nationalIdEnc" TEXT NOT NULL,
    "nationalIdHash" TEXT NOT NULL,
    "crNumberEnc" TEXT NOT NULL,
    "crNumberHash" TEXT NOT NULL,
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'submitted',
    "decision" "Decision",
    "decisionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_checks" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "type" "CheckType" NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "lastError" TEXT,
    "latencyMs" INTEGER,
    "resultPayloadEnc" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "applicationId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "applications_nationalIdHash_crNumberHash_idx" ON "applications"("nationalIdHash", "crNumberHash");

-- CreateIndex
CREATE INDEX "applications_status_updatedAt_idx" ON "applications"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "applications_clientId_idempotencyKey_key" ON "applications"("clientId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "verification_checks_applicationId_type_key" ON "verification_checks"("applicationId", "type");

-- CreateIndex
CREATE INDEX "audit_events_applicationId_createdAt_idx" ON "audit_events"("applicationId", "createdAt");

-- AddForeignKey
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
