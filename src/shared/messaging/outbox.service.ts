import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxMessage, RoutingKey } from './events';
import { RabbitMqService } from './rabbitmq.service';

/**
 * Transactional outbox. Repositories insert the event row (see `toRow`) in the same transaction as
 * the state change it describes; `publishNow` then delivers it straight away, and `relayPending`
 * (run by the worker) delivers whatever could not be published, e.g. while the broker was down.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqService,
  ) {}

  static toRow(message: OutboxMessage): Prisma.OutboxEventCreateInput {
    return {
      id: message.id,
      routingKey: message.routingKey,
      aggregateId: message.aggregateId,
      payload: message.payload as Prisma.InputJsonObject,
    };
  }

  /** Best effort: never throws. A failure leaves the row for the relay. */
  async publishNow(message: OutboxMessage): Promise<boolean> {
    try {
      await this.rabbit.publishEvent(message);
      await this.prisma.outboxEvent.update({
        where: { id: message.id },
        data: { publishedAt: new Date(), attempts: { increment: 1 } },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `${message.routingKey} for ${message.aggregateId} not published yet, relay will retry: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Publishes unpublished events older than `olderThanMs`, oldest first. Returns how many went out. */
  async relayPending(olderThanMs: number, limit = 100): Promise<number> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let published = 0;
    for (const row of rows) {
      const ok = await this.publishNow({
        id: row.id,
        routingKey: row.routingKey as RoutingKey,
        aggregateId: row.aggregateId,
        payload: row.payload as object,
      });
      if (!ok) break; // broker still unavailable: try again on the next run
      published++;
    }
    return published;
  }

  /** Published rows are transport records, not the audit trail (that is audit_events). */
  async purgePublished(olderThan: Date): Promise<number> {
    const { count } = await this.prisma.outboxEvent.deleteMany({
      where: { publishedAt: { lt: olderThan } },
    });
    return count;
  }
}
