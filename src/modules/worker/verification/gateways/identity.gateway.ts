import { Injectable } from '@nestjs/common';
import { CheckType } from '../../../../shared/applications/application.types';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { GatewayOutcome, VerificationGateway, VerificationSubject } from './gateway.types';
import { HttpGatewayClient } from './http-gateway.client';

/** Nafath / Yakeen: is this National ID real and verified? */
@Injectable()
export class IdentityGateway implements VerificationGateway {
  readonly checkType = CheckType.identity;

  constructor(
    private readonly http: HttpGatewayClient,
    private readonly config: AppConfigService,
  ) {}

  async verify(subject: VerificationSubject): Promise<GatewayOutcome> {
    const res = await this.http.post({
      provider: 'nafath',
      path: '/nafath/verify',
      payload: { nationalId: subject.nationalId },
      timeoutMs: this.config.get('GATEWAY_TIMEOUT_MS'),
      correlationId: subject.applicationId,
    });

    const body = res.body as { verificationStatus?: unknown } | undefined;
    if (res.status !== 200 || !body) {
      return { status: 'ambiguous', reasonCode: `IDENTITY_UNEXPECTED_RESPONSE_${res.status}` };
    }
    switch (body.verificationStatus) {
      case 'VERIFIED':
        return { status: 'verified', data: { verificationStatus: 'VERIFIED' } };
      case 'NOT_VERIFIED':
        return { status: 'failed', reasonCode: 'IDENTITY_NOT_VERIFIED' };
      default:
        // e.g. PENDING_CONFIRMATION: the provider answered, but not with something we can act on.
        return { status: 'ambiguous', reasonCode: 'IDENTITY_STATUS_INCONCLUSIVE' };
    }
  }
}
