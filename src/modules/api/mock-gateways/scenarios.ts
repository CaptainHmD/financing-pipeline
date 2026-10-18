/**
 * Deterministic failure scenarios for the mocked gateways, selected by "magic" digits so every
 * messy case is reproducible from Postman:
 *   - Nafath/Yakeen: LAST digit of the National ID
 *   - Wathiq:        LAST digit of the CR number
 *   - SIMAH:         SECOND-TO-LAST digit of the National ID
 * Any digit not listed is the happy path.
 */
export type ScenarioTable = Record<string, string>;

export const NAFATH_SCENARIOS: ScenarioTable = {
  '1': 'NOT_VERIFIED: identity could not be verified (definitive failure)',
  '2': 'FLAKY: 503 twice, then VERIFIED',
  '3': 'AMBIGUOUS: 200 with verificationStatus=PENDING_CONFIRMATION',
  '4': 'DOWN: always 503 (retries exhausted -> unavailable)',
  default: 'VERIFIED',
};

export const WATHIQ_SCENARIOS: ScenarioTable = {
  '1': 'EXPIRED: CR status Expired (definitive failure)',
  '2': 'SLOW: first call exceeds the client timeout, then ACTIVE',
  '3': 'HANGING: every call exceeds the client timeout',
  '4': 'NOT_FOUND: 404, CR does not exist (definitive failure)',
  '5': 'MALFORMED: 200 with a non-JSON maintenance page',
  default: 'ACTIVE',
};

export const SIMAH_SCENARIOS: ScenarioTable = {
  '1': 'POOR: score 480',
  '2': 'FLAKY: 503 twice, then score 720',
  '3': 'DOWN: always 503',
  '4': 'BORDERLINE: score 600',
  '5': 'DEFAULTS: score 700 with 2 active defaults',
  '6': 'NO_HIT: no credit file (ambiguous)',
  default: 'GOOD: score 720, no defaults',
};
