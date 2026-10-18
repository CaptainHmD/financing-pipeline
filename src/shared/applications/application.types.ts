import { ApplicationStatus, CheckStatus, CheckType, Decision } from '@prisma/client';

export { ApplicationStatus, CheckStatus, CheckType, Decision };

/** Allowed lifecycle transitions; the repository applies them as conditional (compare-and-set) updates. */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  submitted: ['verifying'],
  verifying: ['decided'],
  decided: [],
};

export function allowedSourcesFor(target: ApplicationStatus): ApplicationStatus[] {
  return (Object.keys(APPLICATION_TRANSITIONS) as ApplicationStatus[]).filter((from) =>
    APPLICATION_TRANSITIONS[from].includes(target),
  );
}

export const ALL_CHECK_TYPES: readonly CheckType[] = [
  CheckType.identity,
  CheckType.commercial_registration,
  CheckType.credit,
];

export const FINAL_CHECK_STATUSES: readonly CheckStatus[] = [
  CheckStatus.verified,
  CheckStatus.failed,
  CheckStatus.ambiguous,
  CheckStatus.unavailable,
];

export interface CheckSummary {
  type: CheckType;
  status: CheckStatus;
  attempts: number;
  reasonCode: string | null;
  lastError: string | null;
  latencyMs: number | null;
  completedAt: Date | null;
}

/** Application with PII decrypted. Never log or serialise this directly; see ApplicationResponseDto. */
export interface ApplicationRecord {
  id: string;
  clientId: string;
  requestHash: string;
  nationalId: string;
  crNumber: string;
  requestedAmount: number;
  status: ApplicationStatus;
  decision: Decision | null;
  decisionReasons: string[];
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  checks: CheckSummary[];
}

export interface NewApplication {
  id: string;
  clientId: string;
  idempotencyKey: string;
  requestHash: string;
  nationalId: string;
  crNumber: string;
  requestedAmount: number;
}
