import { CheckStatus, CheckType, Decision } from '../../../shared/applications/application.types';
import { CheckState } from '../verification/verification.repository';
import { DecisionService } from './decision.service';

const verified = (type: CheckType, data: Record<string, unknown> | null = null): CheckState => ({
  type,
  status: CheckStatus.verified,
  reasonCode: null,
  data,
});
const withStatus = (type: CheckType, status: CheckStatus, reasonCode: string | null = null) => ({
  type,
  status,
  reasonCode,
  data: null,
});

const identity = verified(CheckType.identity);
const cr = verified(CheckType.commercial_registration);
const credit = (score: number, activeDefaults = 0) =>
  verified(CheckType.credit, { score, activeDefaults });

describe('DecisionService', () => {
  const service = new DecisionService();
  const decide = (checks: CheckState[], requestedAmount = 250_000) =>
    service.decide({ requestedAmount, checks });

  it('approves for risk assessment when every check is clean', () => {
    expect(decide([identity, cr, credit(720)])).toEqual({
      decision: Decision.approved_for_risk_assessment,
      reasons: ['ALL_CHECKS_PASSED'],
    });
  });

  it.each<[string, CheckState[], string[]]>([
    [
      'identity not verified',
      [
        withStatus(CheckType.identity, CheckStatus.failed, 'IDENTITY_NOT_VERIFIED'),
        cr,
        credit(720),
      ],
      ['IDENTITY_NOT_VERIFIED'],
    ],
    [
      'CR expired',
      [
        identity,
        withStatus(CheckType.commercial_registration, CheckStatus.failed, 'CR_EXPIRED'),
        credit(720),
      ],
      ['CR_EXPIRED'],
    ],
    ['score below 550', [identity, cr, credit(549)], ['CREDIT_SCORE_BELOW_MINIMUM']],
    ['active defaults', [identity, cr, credit(700, 1)], ['CREDIT_ACTIVE_DEFAULTS']],
    [
      'several negatives',
      [identity, cr, credit(480, 2)],
      ['CREDIT_ACTIVE_DEFAULTS', 'CREDIT_SCORE_BELOW_MINIMUM'],
    ],
  ])('rejects: %s', (_name, checks, reasons) => {
    expect(decide(checks)).toEqual({ decision: Decision.rejected, reasons });
  });

  it.each<[string, CheckState[], number, string[]]>([
    ['borderline score', [identity, cr, credit(600)], 250_000, ['CREDIT_SCORE_BORDERLINE']],
    [
      'identity ambiguous',
      [
        withStatus(CheckType.identity, CheckStatus.ambiguous, 'IDENTITY_STATUS_INCONCLUSIVE'),
        cr,
        credit(720),
      ],
      250_000,
      ['IDENTITY_STATUS_INCONCLUSIVE'],
    ],
    [
      'credit unavailable',
      [identity, cr, withStatus(CheckType.credit, CheckStatus.unavailable, 'RETRIES_EXHAUSTED')],
      250_000,
      ['CREDIT_UNAVAILABLE'],
    ],
    ['check never settled', [identity, cr], 250_000, ['CREDIT_UNAVAILABLE']],
    [
      'malformed credit report',
      [identity, cr, verified(CheckType.credit, { score: 'high' })],
      250_000,
      ['CREDIT_REPORT_INVALID'],
    ],
    [
      'amount above the limit',
      [identity, cr, credit(720)],
      1_000_001,
      ['AMOUNT_ABOVE_AUTO_PROCESSING_LIMIT'],
    ],
  ])('sends to manual review: %s', (_name, checks, amount, reasons) => {
    expect(decide(checks, amount)).toEqual({
      decision: Decision.requires_manual_compliance_review,
      reasons,
    });
  });

  it('lets a rejection win over uncertainty', () => {
    const checks = [
      withStatus(CheckType.identity, CheckStatus.unavailable),
      withStatus(CheckType.commercial_registration, CheckStatus.failed, 'CR_EXPIRED'),
      credit(600),
    ];
    expect(decide(checks, 2_000_000)).toEqual({
      decision: Decision.rejected,
      reasons: ['CR_EXPIRED'],
    });
  });

  it('accepts the auto-processing limit itself', () => {
    expect(decide([identity, cr, credit(650)], 1_000_000).decision).toBe(
      Decision.approved_for_risk_assessment,
    );
  });

  it('applies injected thresholds', () => {
    const strict = new DecisionService({
      minCreditScore: 700,
      borderlineCreditScore: 750,
      maxActiveDefaults: 0,
      autoProcessingLimitSar: 100_000,
    } as never);
    expect(strict.decide({ requestedAmount: 50_000, checks: [identity, cr, credit(720)] })).toEqual(
      {
        decision: Decision.requires_manual_compliance_review,
        reasons: ['CREDIT_SCORE_BORDERLINE'],
      },
    );
  });
});
