import { AppConfigService } from '../../../../shared/config/app-config.service';
import { CreditBureauGateway } from './credit-bureau.gateway';
import { CrRegistryGateway } from './cr-registry.gateway';
import { GatewayOutcome } from './gateway.types';
import { GatewayHttpResponse, HttpGatewayClient } from './http-gateway.client';
import { IdentityGateway } from './identity.gateway';

const config = { get: () => 1000 } as unknown as AppConfigService;
const subject = { applicationId: 'app-1', nationalId: '1012345670', crNumber: '7001234560' };

/** An HTTP client stub that answers every call with the given response. */
const answering = (status: number, body: unknown) =>
  ({
    post: jest.fn<Promise<GatewayHttpResponse>, []>().mockResolvedValue({ status, body }),
  }) as unknown as HttpGatewayClient;

describe('IdentityGateway (Nafath / Yakeen)', () => {
  const verify = (status: number, body: unknown) =>
    new IdentityGateway(answering(status, body), config).verify(subject);

  it.each<[string, number, unknown, GatewayOutcome]>([
    [
      'verified',
      200,
      { verificationStatus: 'VERIFIED' },
      { status: 'verified', data: { verificationStatus: 'VERIFIED' } },
    ],
    [
      'not verified',
      200,
      { verificationStatus: 'NOT_VERIFIED' },
      { status: 'failed', reasonCode: 'IDENTITY_NOT_VERIFIED' },
    ],
    [
      'pending confirmation',
      200,
      { verificationStatus: 'PENDING_CONFIRMATION' },
      { status: 'ambiguous', reasonCode: 'IDENTITY_STATUS_INCONCLUSIVE' },
    ],
    [
      'non-JSON body',
      200,
      undefined,
      { status: 'ambiguous', reasonCode: 'IDENTITY_UNEXPECTED_RESPONSE_200' },
    ],
    [
      'unexpected status',
      400,
      { error: 'bad request' },
      { status: 'ambiguous', reasonCode: 'IDENTITY_UNEXPECTED_RESPONSE_400' },
    ],
  ])('%s', async (_name, status, body, expected) => {
    await expect(verify(status, body)).resolves.toEqual(expected);
  });
});

describe('CrRegistryGateway (Wathiq)', () => {
  const verify = (status: number, body: unknown) =>
    new CrRegistryGateway(answering(status, body), config).verify(subject);

  it('verifies an active CR', async () => {
    await expect(verify(200, { status: 'ACTIVE', expiryDate: '2027-12-31' })).resolves.toEqual({
      status: 'verified',
      data: { crStatus: 'ACTIVE', expiryDate: '2027-12-31' },
    });
  });

  it.each<[string, number, unknown, string, string]>([
    ['expired', 200, { status: 'EXPIRED' }, 'failed', 'CR_EXPIRED'],
    ['suspended', 200, { status: 'SUSPENDED' }, 'failed', 'CR_INACTIVE'],
    ['cancelled', 200, { status: 'CANCELLED' }, 'failed', 'CR_INACTIVE'],
    ['not found', 404, { error: 'CR_NOT_FOUND' }, 'failed', 'CR_NOT_FOUND'],
    ['HTML maintenance page', 200, undefined, 'ambiguous', 'CR_UNEXPECTED_RESPONSE'],
    ['unknown status', 200, { status: 'UNDER_REVIEW' }, 'ambiguous', 'CR_STATUS_UNKNOWN'],
  ])('%s -> %s %s', async (_name, status, body, outcome, reasonCode) => {
    await expect(verify(status, body)).resolves.toMatchObject({ status: outcome, reasonCode });
  });
});

describe('CreditBureauGateway (SIMAH)', () => {
  const verify = (status: number, body: unknown) =>
    new CreditBureauGateway(answering(status, body), config).verify(subject);

  it('returns the normalised report without judging it', async () => {
    await expect(verify(200, { score: 480, activeDefaults: 0, message: 'OK' })).resolves.toEqual({
      status: 'verified',
      data: { score: 480, activeDefaults: 0 },
    });
  });

  it.each<[string, unknown, string]>([
    ['no credit file', { score: null, activeDefaults: 0, message: 'NO_HIT' }, 'CREDIT_NO_RECORD'],
    ['score out of range', { score: 1200, activeDefaults: 0 }, 'CREDIT_REPORT_INVALID'],
    ['missing defaults', { score: 700 }, 'CREDIT_REPORT_INVALID'],
    ['non-JSON body', undefined, 'CREDIT_UNEXPECTED_RESPONSE'],
  ])('%s -> ambiguous %s', async (_name, body, reasonCode) => {
    await expect(verify(200, body)).resolves.toEqual({ status: 'ambiguous', reasonCode });
  });
});
