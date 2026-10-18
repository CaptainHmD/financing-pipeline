import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import amqp, { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { AppConfigService } from '../config/app-config.service';
import { OutboxMessage } from './events';
import { assertTopology, EVENTS_EXCHANGE, RETRY_EXCHANGE, retryDelays } from './topology';

const ATTEMPT_HEADER = 'x-attempt';

export interface DeliveredMessage<T> {
  payload: T;
  /** 1-based; incremented each time the message comes back from a retry queue. */
  attempt: number;
  isLastAttempt: boolean;
}

export type MessageHandler<T> = (message: DeliveredMessage<T>) => Promise<void>;

/**
 * Thin wrapper over amqp-connection-manager: reconnects automatically, re-declares the topology
 * and re-attaches consumers on every reconnect, and publishes with publisher confirms.
 *
 * Delivery is at-least-once: handlers must be idempotent.
 * - handler resolves  -> ack
 * - handler throws    -> republished to a delay queue (exponential backoff), then dead-lettered
 *                        once RETRY_ATTEMPTS is reached
 * - unparseable body  -> dead-lettered straight away
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly delaysMs: number[];
  private readonly maxAttempts: number;
  private connection: AmqpConnectionManager;
  private publisher: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];

  constructor(private readonly config: AppConfigService) {
    this.maxAttempts = config.get('RETRY_ATTEMPTS');
    this.delaysMs = retryDelays(this.maxAttempts, config.get('RETRY_BACKOFF_MS'));
  }

  onModuleInit(): void {
    // Does not block startup: while the broker is unreachable, publishes fail after
    // RABBITMQ_PUBLISH_TIMEOUT_MS and the outbox relay delivers them later.
    this.connection = amqp.connect([this.config.get('RABBITMQ_URL')], {
      heartbeatIntervalInSeconds: 15,
    });
    // Reconnect attempts repeat every few seconds: log each distinct failure once, not every attempt.
    let lastConnectError: string | undefined;
    this.connection.on('connect', () => {
      lastConnectError = undefined;
      this.logger.log('Connected to RabbitMQ');
    });
    this.connection.on('connectFailed', ({ err }) => {
      const reason = err?.message ?? 'unknown reason';
      if (reason === lastConnectError) return;
      lastConnectError = reason;
      this.logger.error(`Cannot connect to RabbitMQ (will keep retrying): ${reason}`);
    });
    this.connection.on('disconnect', ({ err }) =>
      this.logger.warn(`Disconnected from RabbitMQ: ${err?.message ?? 'unknown reason'}`),
    );
    this.publisher = this.connection.createChannel({
      confirm: true,
      publishTimeout: this.config.get('RABBITMQ_PUBLISH_TIMEOUT_MS'),
      setup: (ch: ConfirmChannel) => assertTopology(ch, this.delaysMs),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.consumers, this.publisher].map((c) => c?.close()));
    await this.connection?.close();
  }

  /** Publishes a domain event; resolves once the broker has confirmed it. */
  async publishEvent(message: OutboxMessage): Promise<void> {
    await this.publisher.publish(
      EVENTS_EXCHANGE,
      message.routingKey,
      Buffer.from(JSON.stringify(message.payload)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: message.id,
        type: message.routingKey,
        correlationId: message.aggregateId,
        timestamp: Math.floor(Date.now() / 1000),
        headers: { [ATTEMPT_HEADER]: 1 },
      },
    );
  }

  /** Starts consuming `queue` with at most `prefetch` unacknowledged messages in flight. */
  consume<T>(queue: string, prefetch: number, handle: MessageHandler<T>): void {
    const channel = this.connection.createChannel({
      confirm: true,
      setup: async (ch: ConfirmChannel) => {
        await assertTopology(ch, this.delaysMs);
        await ch.prefetch(prefetch);
        await ch.consume(queue, (raw) => {
          if (raw) void this.deliver(ch, queue, raw, handle);
        });
      },
    });
    this.consumers.push(channel);
  }

  private async deliver<T>(
    ch: ConfirmChannel,
    queue: string,
    raw: ConsumeMessage,
    handle: MessageHandler<T>,
  ): Promise<void> {
    const attempt = Number(raw.properties.headers?.[ATTEMPT_HEADER] ?? 1);
    let payload: T;
    try {
      payload = JSON.parse(raw.content.toString()) as T;
    } catch {
      this.logger.error(
        `Unparseable message ${raw.properties.messageId} on ${queue}, dead-lettering`,
      );
      return settle(() => ch.nack(raw, false, false));
    }

    try {
      await handle({ payload, attempt, isLastAttempt: attempt >= this.maxAttempts });
      settle(() => ch.ack(raw));
    } catch (err) {
      await this.retryOrDeadLetter(ch, queue, raw, attempt, err as Error);
    }
  }

  private async retryOrDeadLetter(
    ch: ConfirmChannel,
    queue: string,
    raw: ConsumeMessage,
    attempt: number,
    err: Error,
  ): Promise<void> {
    const delay = this.delaysMs[attempt - 1];
    if (delay === undefined) {
      this.logger.error(
        `${queue}: giving up after ${attempt} attempts, dead-lettering (${err.message})`,
      );
      return settle(() => ch.nack(raw, false, false));
    }

    const props = raw.properties;
    const options: Options.Publish = {
      persistent: true,
      contentType: props.contentType,
      messageId: props.messageId,
      type: props.type,
      correlationId: props.correlationId,
      timestamp: props.timestamp,
      headers: { ...props.headers, [ATTEMPT_HEADER]: attempt + 1, 'x-last-error': err.message },
    };
    try {
      await this.publisher.publish(RETRY_EXCHANGE, `${delay}.${queue}`, raw.content, options);
      settle(() => ch.ack(raw));
    } catch (publishErr) {
      // Could not schedule the retry: hand the message back to the queue unchanged.
      this.logger.warn(`${queue}: could not schedule retry (${(publishErr as Error).message})`);
      settle(() => ch.nack(raw, false, true));
    }
  }
}

/** Ack/nack on a channel that closed in the meantime throws; the broker redelivers anyway. */
function settle(fn: () => void): void {
  try {
    fn();
  } catch {
    /* channel already closed */
  }
}
