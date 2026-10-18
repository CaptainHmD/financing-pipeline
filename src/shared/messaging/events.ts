import { CheckStatus, CheckType, Decision } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/** Routing keys of the domain events published on the events exchange. */
export const RoutingKey = {
  applicationSubmitted: 'application.submitted',
  checkCompleted: 'check.completed',
  applicationDecided: 'application.decided',
} as const;

export type RoutingKey = (typeof RoutingKey)[keyof typeof RoutingKey];

/** Events carry identifiers only, never PII: consumers re-read (and decrypt) data from the DB. */
export interface ApplicationSubmittedEvent {
  applicationId: string;
}

export interface CheckCompletedEvent {
  applicationId: string;
  checkType: CheckType;
  status: CheckStatus;
}

export interface ApplicationDecidedEvent {
  applicationId: string;
  decision: Decision;
  reasons: string[];
}

/** An event as stored in the outbox and published to RabbitMQ (id doubles as the AMQP messageId). */
export interface OutboxMessage<T extends object = object> {
  id: string;
  routingKey: RoutingKey;
  aggregateId: string;
  payload: T;
}

export function outboxMessage<T extends object>(
  routingKey: RoutingKey,
  aggregateId: string,
  payload: T,
): OutboxMessage<T> {
  return { id: randomUUID(), routingKey, aggregateId, payload };
}
