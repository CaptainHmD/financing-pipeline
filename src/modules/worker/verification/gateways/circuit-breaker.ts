import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before a single trial call is allowed. */
  cooldownMs: number;
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Consecutive-failure circuit breaker for one provider.
 *
 *   closed ──(N consecutive failures)──► open ──(cooldown)──► half_open
 *     ▲                                    ▲                     │
 *     └──────────── trial succeeds ────────┴──── trial fails ────┘
 *
 * While open, calls fail fast instead of piling more load onto a provider that is already down;
 * the queue retries them later. Only transport-level failures (timeouts, 5xx, 429) count: a clear
 * negative answer such as "CR not found" means the provider is healthy.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /** Whether a call may go out now. In half-open, only one trial call at a time is allowed. */
  tryAcquire(): boolean {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.options.cooldownMs) return false;
      this.transition('half_open');
    }
    if (this.state === 'half_open') {
      if (this.trialInFlight) return false;
      this.trialInFlight = true;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state === 'open') return; // a straggler that started before the circuit opened
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
    if (this.state === 'half_open') this.transition('closed');
  }

  recordFailure(): void {
    if (this.state === 'open') return;
    if (this.state === 'half_open') {
      this.open();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.options.failureThreshold) this.open();
  }

  private open(): void {
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
    this.transition('open');
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.options.onStateChange?.(from, to);
  }
}

/**
 * One breaker per provider, per worker process. State is deliberately local: each process
 * protects its own calls, and losing it on restart only costs a few extra trial calls.
 */
@Injectable()
export class CircuitBreakerRegistry {
  private readonly logger = new Logger('CircuitBreaker');
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly config: AppConfigService) {}

  get(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      const failureThreshold = this.config.get('CIRCUIT_BREAKER_FAILURE_THRESHOLD');
      const cooldownMs = this.config.get('CIRCUIT_BREAKER_COOLDOWN_MS');
      breaker = new CircuitBreaker({
        failureThreshold,
        cooldownMs,
        onStateChange: (_from, to) => {
          if (to === 'open') {
            this.logger.warn(
              `${provider} circuit OPEN for ${cooldownMs} ms after ${failureThreshold} consecutive failures`,
            );
          } else if (to === 'half_open') {
            this.logger.log(`${provider} circuit HALF-OPEN: sending one trial request`);
          } else {
            this.logger.log(`${provider} circuit CLOSED: provider recovered`);
          }
        },
      });
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }
}
