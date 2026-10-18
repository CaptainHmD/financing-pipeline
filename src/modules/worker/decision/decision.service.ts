import { Injectable } from '@nestjs/common';
import { CheckStatus, CheckType, Decision } from '../../../shared/applications/application.types';
import { CheckState } from '../verification/verification.repository';
import { DECISION_RULES, DecisionRules } from './decision.rules';

export interface DecisionInput {
  requestedAmount: number;
  checks: CheckState[];
}

export interface DecisionResult {
  decision: Decision;
  reasons: string[];
}

const LABEL: Record<CheckType, string> = {
  identity: 'IDENTITY',
  commercial_registration: 'CR',
  credit: 'CREDIT',
};

/**
 * Pure eligibility rules (no I/O).
 * Precedence: any definitive negative -> rejected; otherwise any uncertainty -> manual review;
 * otherwise approved for risk assessment. "Unknown" (provider down / ambiguous) never rejects.
 */
@Injectable()
export class DecisionService {
  constructor(private readonly rules: DecisionRules = DECISION_RULES) {}

  decide(input: DecisionInput): DecisionResult {
    const reject: string[] = [];
    const review: string[] = [];

    for (const type of [CheckType.identity, CheckType.commercial_registration, CheckType.credit]) {
      const check = input.checks.find((c) => c.type === type);
      const label = LABEL[type];
      switch (check?.status) {
        case CheckStatus.verified:
          if (type === CheckType.credit) this.assessCredit(check.data, reject, review);
          break;
        case CheckStatus.failed:
          reject.push(check.reasonCode ?? `${label}_FAILED`);
          break;
        case CheckStatus.ambiguous:
          review.push(check.reasonCode ?? `${label}_AMBIGUOUS`);
          break;
        default:
          // unavailable, or (defensively) a check that never settled
          review.push(`${label}_UNAVAILABLE`);
      }
    }

    if (input.requestedAmount > this.rules.autoProcessingLimitSar) {
      review.push('AMOUNT_ABOVE_AUTO_PROCESSING_LIMIT');
    }

    if (reject.length) return { decision: Decision.rejected, reasons: reject };
    if (review.length)
      return { decision: Decision.requires_manual_compliance_review, reasons: review };
    return { decision: Decision.approved_for_risk_assessment, reasons: ['ALL_CHECKS_PASSED'] };
  }

  private assessCredit(
    data: Record<string, unknown> | null,
    reject: string[],
    review: string[],
  ): void {
    const score = data?.score;
    const activeDefaults = data?.activeDefaults;
    if (typeof score !== 'number' || typeof activeDefaults !== 'number') {
      review.push('CREDIT_REPORT_INVALID');
      return;
    }
    if (activeDefaults > this.rules.maxActiveDefaults) reject.push('CREDIT_ACTIVE_DEFAULTS');
    if (score < this.rules.minCreditScore) reject.push('CREDIT_SCORE_BELOW_MINIMUM');
    else if (score < this.rules.borderlineCreditScore) review.push('CREDIT_SCORE_BORDERLINE');
  }
}
