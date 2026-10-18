import { Injectable } from '@nestjs/common';
import { CheckType } from '../../../../shared/applications/application.types';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { GatewayOutcome, VerificationGateway, VerificationSubject } from './gateway.types';
import { HttpGatewayClient } from './http-gateway.client';

/** Wathiq: is the Commercial Registration active? */
@Injectable()
export class CrRegistryGateway implements VerificationGateway {
  readonly checkType = CheckType.commercial_registration;

  constructor(
    private readonly http: HttpGatewayClient,
    private readonly config: AppConfigService,
  ) {}

  async verify(subject: VerificationSubject): Promise<GatewayOutcome> {
    const res = await this.http.post({
      provider: 'wathiq',
      path: '/wathiq/cr-status',
      payload: { crNumber: subject.crNumber },
      timeoutMs: this.config.get('WATHIQ_TIMEOUT_MS'),
      correlationId: subject.applicationId,
    });

    if (res.status === 404) return { status: 'failed', reasonCode: 'CR_NOT_FOUND' };

    const body = res.body as { status?: unknown; expiryDate?: unknown } | undefined;
    if (res.status !== 200 || !body) {
      return { status: 'ambiguous', reasonCode: 'CR_UNEXPECTED_RESPONSE' };
    }
    const data = { crStatus: body.status, expiryDate: body.expiryDate };
    switch (body.status) {
      case 'ACTIVE':
        return { status: 'verified', data };
      case 'EXPIRED':
        return { status: 'failed', reasonCode: 'CR_EXPIRED', data };
      case 'SUSPENDED':
      case 'CANCELLED':
        return { status: 'failed', reasonCode: 'CR_INACTIVE', data };
      default:
        return { status: 'ambiguous', reasonCode: 'CR_STATUS_UNKNOWN' };
    }
  }
}
