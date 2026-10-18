import { CircuitBreaker, CircuitState } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let now: number;
  let transitions: string[];
  let breaker: CircuitBreaker;

  beforeEach(() => {
    now = 0;
    transitions = [];
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      now: () => now,
      onStateChange: (from: CircuitState, to: CircuitState) => transitions.push(`${from}->${to}`),
    });
  });

  const fail = (times: number) => {
    for (let i = 0; i < times; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.recordFailure();
    }
  };

  it('lets calls through while closed', () => {
    expect(breaker.currentState).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens after the threshold of consecutive failures', () => {
    fail(2);
    expect(breaker.currentState).toBe('closed');
    fail(1);
    expect(breaker.currentState).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    expect(transitions).toEqual(['closed->open']);
  });

  it('only counts consecutive failures', () => {
    fail(2);
    breaker.recordSuccess();
    fail(2);
    expect(breaker.currentState).toBe('closed');
  });

  it('stays open until the cooldown has passed', () => {
    fail(3);
    now = 999;
    expect(breaker.tryAcquire()).toBe(false);
    now = 1000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.currentState).toBe('half_open');
  });

  it('allows a single trial call while half-open', () => {
    fail(3);
    now = 1000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes when the trial call succeeds', () => {
    fail(3);
    now = 1000;
    breaker.tryAcquire();
    breaker.recordSuccess();
    expect(breaker.currentState).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('reopens for a full cooldown when the trial call fails', () => {
    fail(3);
    now = 1000;
    breaker.tryAcquire();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
    now = 1999;
    expect(breaker.tryAcquire()).toBe(false);
    now = 2000;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('ignores results of calls that started before the circuit opened', () => {
    fail(3);
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
    now = 1000;
    expect(breaker.tryAcquire()).toBe(true);
  });
});
