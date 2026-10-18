import { Injectable } from '@nestjs/common';
import { CheckType } from '../../../../shared/applications/application.types';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { GatewayOutcome, VerificationGateway, VerificationSubject } from './gateway.types';
import { HttpGatewayClient } from './http-gateway.client';

export interface CreditReportData extends Record<string, unknown> {
  score: number;
  activeDefaults: number;
}

/**
 * SIMAH: fetches credit standing. The adapter only validates and normalises the report;
 * judging the score is the decision engine's job.
 */
@Injectable()
export class CreditBureauGateway implements VerificationGateway {
  readonly checkType = CheckType.credit;

  constructor(
    private readonly http: HttpGatewayClient,
    private readonly config: AppConfigService,
  ) {}

  async verify(subject: VerificationSubject): Promise<GatewayOutcome> {
    const res = await this.http.post({
      provider: 'simah',
      path: '/simah/credit-report',
      payload: { nationalId: subject.nationalId, crNumber: subject.crNumber },
      timeoutMs: this.config.get('GATEWAY_TIMEOUT_MS'),
      correlationId: subject.applicationId,
    });

    const body = res.body as { score?: unknown; activeDefaults?: unknown; message?: unknown };
    if (res.status !== 200 || !body) {
      return { status: 'ambiguous', reasonCode: 'CREDIT_UNEXPECTED_RESPONSE' };
    }
    if (body.message === 'NO_HIT') {
      return { status: 'ambiguous', reasonCode: 'CREDIT_NO_RECORD' };
    }
    const { score, activeDefaults } = body;
    if (!isInt(score, 300, 900) || !isInt(activeDefaults, 0, 1000)) {
      return { status: 'ambiguous', reasonCode: 'CREDIT_REPORT_INVALID' };
    }
    const data: CreditReportData = { score, activeDefaults };
    return { status: 'verified', data };
  }
}

function isInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}
