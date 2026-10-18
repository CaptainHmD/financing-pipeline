import { CheckType } from '@prisma/client';
import type { ConfirmChannel } from 'amqplib';
import { RoutingKey } from './events';

/**
 * RabbitMQ topology (declared idempotently by every process on connect):
 *
 *   events (topic) ── application.submitted ──► verification.identity
 *                                            ├► verification.commercial_registration
 *                                            └► verification.credit
 *                  ── check.completed ───────► decision
 *
 *   Retries without plugins: a failed message is republished to `retry` with routing key
 *   `<delayMs>.<queue>`, waits in the `retry.<delayMs>` queue until its TTL expires, then is
 *   dead-lettered to `requeue`, which routes it back to `<queue>` only.
 *   Messages that exhaust every attempt are dead-lettered to `dead-letter` for inspection.
 */
export const EVENTS_EXCHANGE = 'financing.events';
export const RETRY_EXCHANGE = 'financing.retry';
export const REQUEUE_EXCHANGE = 'financing.requeue';
export const DEAD_LETTER_EXCHANGE = 'financing.dlx';
export const DEAD_LETTER_QUEUE = 'financing.dead-letter';
export const DECISION_QUEUE = 'decision';

export const verificationQueue = (type: CheckType): string => `verification.${type}`;
export const retryQueue = (delayMs: number): string => `${RETRY_EXCHANGE}.${delayMs}ms`;

const SUBSCRIPTIONS: readonly { queue: string; routingKey: RoutingKey }[] = [
  ...Object.values(CheckType).map((type) => ({
    queue: verificationQueue(type),
    routingKey: RoutingKey.applicationSubmitted,
  })),
  { queue: DECISION_QUEUE, routingKey: RoutingKey.checkCompleted },
];

/** Exponential backoff: delay before attempt n+1 is base * 2^(n-1). */
export function retryDelays(attempts: number, baseDelayMs: number): number[] {
  return Array.from({ length: attempts - 1 }, (_, i) => baseDelayMs * 2 ** i);
}

export async function assertTopology(
  ch: ConfirmChannel,
  delaysMs: readonly number[],
): Promise<void> {
  await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(RETRY_EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(REQUEUE_EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });

  await ch.assertQueue(DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await ch.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');

  for (const { queue, routingKey } of SUBSCRIPTIONS) {
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE },
    });
    await ch.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
    await ch.bindQueue(queue, REQUEUE_EXCHANGE, `*.${queue}`);
  }

  for (const delay of new Set(delaysMs)) {
    const queue = retryQueue(delay);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-message-ttl': delay, 'x-dead-letter-exchange': REQUEUE_EXCHANGE },
    });
    await ch.bindQueue(queue, RETRY_EXCHANGE, `${delay}.#`);
  }
}
