import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../shared/config/app-config.service';

export interface MockReply {
  status: number;
  /** JSON body, or a raw string to simulate malformed responses. */
  body: unknown;
  delayMs?: number;
}

const unavailable = (provider: string): MockReply => ({
  status: 503,
  body: { error: 'SERVICE_UNAVAILABLE', message: `${provider} is temporarily unavailable` },
});

/** Simulated external providers. Behaviour is driven by the digits documented in scenarios.ts. */
@Injectable()
export class MockGatewaysService {
  /** Per-correlation call counters to simulate "fails N times then recovers". */
  private readonly calls = new Map<string, number>();

  constructor(private readonly config: AppConfigService) {}

  nafath(nationalId: string, correlationId: string): MockReply {
    const attempt = this.countCall('nafath', correlationId);
    switch (lastDigit(nationalId)) {
      case '1':
        return ok({ requestId: randomUUID(), verificationStatus: 'NOT_VERIFIED' });
      case '2':
        if (attempt <= 2) return unavailable('Nafath');
        return ok({ requestId: randomUUID(), verificationStatus: 'VERIFIED' });
      case '3':
        return ok({ requestId: randomUUID(), verificationStatus: 'PENDING_CONFIRMATION' });
      case '4':
        return unavailable('Nafath');
      default:
        return (
          this.chaos('Nafath') ?? ok({ requestId: randomUUID(), verificationStatus: 'VERIFIED' })
        );
    }
  }

  wathiq(crNumber: string, correlationId: string): MockReply {
    const attempt = this.countCall('wathiq', correlationId);
    const slow = this.config.get('MOCK_SLOW_RESPONSE_MS');
    const active = ok({
      crNumber,
      crName: 'Mock Trading Est.',
      status: 'ACTIVE',
      expiryDate: '2027-12-31',
    });
    switch (lastDigit(crNumber)) {
      case '1':
        return ok({
          crNumber,
          crName: 'Mock Trading Est.',
          status: 'EXPIRED',
          expiryDate: '2024-01-31',
        });
      case '2':
        return attempt === 1 ? { ...active, delayMs: slow } : active;
      case '3':
        return { ...active, delayMs: slow };
      case '4':
        return { status: 404, body: { error: 'CR_NOT_FOUND' } };
      case '5':
        return { status: 200, body: '<html><body>Scheduled maintenance</body></html>' };
      default:
        return this.chaos('Wathiq') ?? active;
    }
  }

  simah(nationalId: string, correlationId: string): MockReply {
    const attempt = this.countCall('simah', correlationId);
    const report = (score: number | null, activeDefaults = 0) =>
      ok({
        reportId: randomUUID(),
        score,
        activeDefaults,
        message: score === null ? 'NO_HIT' : 'OK',
      });
    switch (secondToLastDigit(nationalId)) {
      case '1':
        return report(480);
      case '2':
        return attempt <= 2 ? unavailable('SIMAH') : report(720);
      case '3':
        return unavailable('SIMAH');
      case '4':
        return report(600);
      case '5':
        return report(700, 2);
      case '6':
        return report(null);
      default:
        return this.chaos('SIMAH') ?? report(720);
    }
  }

  /** Optional random volatility on happy paths (MOCK_CHAOS_RATE in [0,1]). */
  private chaos(provider: string): MockReply | null {
    const rate = this.config.get('MOCK_CHAOS_RATE');
    if (rate <= 0 || Math.random() >= rate) return null;
    return Math.random() < 0.5
      ? unavailable(provider)
      : { status: 200, body: {}, delayMs: this.config.get('MOCK_SLOW_RESPONSE_MS') };
  }

  private countCall(provider: string, correlationId: string): number {
    const key = `${provider}:${correlationId}`;
    const next = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, next);
    return next;
  }
}

const ok = (body: unknown): MockReply => ({ status: 200, body });
const lastDigit = (value: string) => value.slice(-1);
const secondToLastDigit = (value: string) => value.slice(-2, -1);
