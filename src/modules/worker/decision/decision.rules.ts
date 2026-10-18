/** Eligibility thresholds. Kept as data so they can move to config / a rules table later. */
export const DECISION_RULES = {
  /** Below this SIMAH score the application is rejected outright. */
  minCreditScore: 550,
  /** Scores in [minCreditScore, borderlineCreditScore) need a human. */
  borderlineCreditScore: 650,
  /** Max active defaults tolerated. */
  maxActiveDefaults: 0,
  /** Requests above this amount (SAR) always go to manual compliance review. */
  autoProcessingLimitSar: 1_000_000,
} as const;

export type DecisionRules = typeof DECISION_RULES;
