import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApplicationRecord } from '../../../shared/applications/application.types';
import { ApplicationsRepository } from '../../../shared/applications/applications.repository';
import { CryptoService } from '../../../shared/crypto/crypto.service';
import {
  ApplicationSubmittedEvent,
  outboxMessage,
  RoutingKey,
} from '../../../shared/messaging/events';
import { OutboxService } from '../../../shared/messaging/outbox.service';
import { CreateApplicationDto } from './dto/create-application.dto';

export interface SubmitResult {
  application: ApplicationRecord;
  replayed: boolean;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly repository: ApplicationsRepository,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * 1. Idempotency: same key + same payload replays the original; same key + different payload is a 409.
   * 2. Persist the application, its pending checks and the `application.submitted` event in one
   *    transaction (outbox), so the event can never be lost or published for a rolled-back write.
   * 3. Publish the event without waiting for it: if RabbitMQ is down the worker's relay publishes it later.
   */
  async submit(
    clientId: string,
    idempotencyKey: string,
    dto: CreateApplicationDto,
  ): Promise<SubmitResult> {
    // Keyed HMAC, not a plain hash: the payload contains low-entropy PII.
    const requestHash = this.crypto.blindIndex(
      JSON.stringify([dto.nationalId, dto.crNumber, dto.requestedAmount]),
    );

    const existing = await this.repository.findByIdempotencyKey(clientId, idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    if (await this.repository.hasOpenApplication(dto.nationalId, dto.crNumber)) {
      throw new ConflictException(
        'An application for this National ID and CR is already being processed',
      );
    }

    const id = randomUUID();
    const event = outboxMessage<ApplicationSubmittedEvent>(RoutingKey.applicationSubmitted, id, {
      applicationId: id,
    });
    const created = await this.repository.create(
      {
        id,
        clientId,
        idempotencyKey,
        requestHash,
        nationalId: dto.nationalId,
        crNumber: dto.crNumber,
        requestedAmount: dto.requestedAmount,
      },
      event,
    );
    if (!created) {
      // Lost a race on the same idempotency key: behave exactly like a replay.
      const winner = await this.repository.findByIdempotencyKey(clientId, idempotencyKey);
      if (!winner) throw new Error('Idempotency conflict without a stored application');
      return this.replay(winner, requestHash);
    }

    void this.outbox.publishNow(event);
    return { application: created, replayed: false };
  }

  async get(id: string, clientId: string): Promise<ApplicationRecord> {
    const application = await this.repository.findForClient(id, clientId);
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  async events(id: string, clientId: string) {
    const events = await this.repository.listEvents(id, clientId);
    if (!events) throw new NotFoundException('Application not found');
    return events;
  }

  private replay(existing: ApplicationRecord, requestHash: string): SubmitResult {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used with a different payload');
    }
    return { application: existing, replayed: true };
  }
}
