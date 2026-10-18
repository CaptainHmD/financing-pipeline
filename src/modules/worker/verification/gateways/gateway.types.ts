import { CheckType } from '../../../../shared/applications/application.types';

export interface VerificationSubject {
  applicationId: string;
  nationalId: string;
  crNumber: string;
}

/**
 * What a gateway adapter returns once the provider gave a usable answer.
 * Transport-level problems are never returned: they are thrown as TransientGatewayError.
 */
export type GatewayOutcome =
  | { status: 'verified'; data: Record<string, unknown> }
  | { status: 'failed'; reasonCode: string; data?: Record<string, unknown> }
  | { status: 'ambiguous'; reasonCode: string };

/** Port implemented by each external integration (Nafath/Yakeen, Wathiq, SIMAH). */
export interface VerificationGateway {
  readonly checkType: CheckType;
  verify(subject: VerificationSubject): Promise<GatewayOutcome>;
}

export const VERIFICATION_GATEWAYS = Symbol('VERIFICATION_GATEWAYS');

/** Retryable failure: timeout, network error, 5xx, 429. */
export class TransientGatewayError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
  ) {
    super(`${provider} transient failure: ${code}`);
    this.name = 'TransientGatewayError';
  }
}
