import { AppConfigService } from '../../../../shared/config/app-config.service';
import { CircuitBreakerRegistry } from './circuit-breaker';
import { TransientGatewayError } from './gateway.types';
import { HttpGatewayClient } from './http-gateway.client';

const config = {
  get: (key: string) =>
    ({
      GATEWAY_BASE_URL: 'http://mocks.test',
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
      CIRCUIT_BREAKER_COOLDOWN_MS: 60_000,
    })[key],
} as unknown as AppConfigService;

const request = {
  provider: 'simah',
  path: '/simah/credit-report',
  payload: {},
  timeoutMs: 1000,
  correlationId: 'app-1',
};

describe('HttpGatewayClient', () => {
  let fetchMock: jest.SpyInstance;
  let client: HttpGatewayClient;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    client = new HttpGatewayClient(config, new CircuitBreakerRegistry(config));
  });

  afterEach(() => fetchMock.mockRestore());

  const respond = (status: number, body: string) =>
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));

  const transientCode = async () => {
    const err = await client.post(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientGatewayError);
    return (err as TransientGatewayError).code;
  };

  it('returns the status and parsed JSON body', async () => {
    respond(200, '{"score":720}');
    await expect(client.post(request)).resolves.toEqual({ status: 200, body: { score: 720 } });
  });

  it('returns an undefined body when the provider answers with something other than JSON', async () => {
    respond(200, '<html>maintenance</html>');
    await expect(client.post(request)).resolves.toEqual({ status: 200, body: undefined });
  });

  it('hands 4xx answers back to the adapter instead of retrying them', async () => {
    respond(404, '{"error":"CR_NOT_FOUND"}');
    await expect(client.post(request)).resolves.toMatchObject({ status: 404 });
  });

  it.each([500, 503, 429, 408])('treats HTTP %i as transient', async (status) => {
    respond(status, '');
    expect(await transientCode()).toBe(`HTTP_${status}`);
  });

  it('treats a timeout as transient', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    expect(await transientCode()).toBe('TIMEOUT');
  });

  it('treats a connection failure as transient', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await transientCode()).toBe('NETWORK_ERROR');
  });

  it('fails fast without calling the provider once the circuit is open', async () => {
    respond(503, '');
    respond(503, '');
    await transientCode();
    await transientCode();

    expect(await transientCode()).toBe('CIRCUIT_OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps one circuit per provider', async () => {
    respond(503, '');
    respond(503, '');
    await transientCode();
    await transientCode();

    respond(200, '{"verificationStatus":"VERIFIED"}');
    await expect(client.post({ ...request, provider: 'nafath' })).resolves.toMatchObject({
      status: 200,
    });
  });
});
