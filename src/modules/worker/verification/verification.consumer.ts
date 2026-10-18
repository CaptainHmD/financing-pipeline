import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ALL_CHECK_TYPES, CheckType } from '../../../shared/applications/application.types';
import { ApplicationSubmittedEvent } from '../../../shared/messaging/events';
import { DeliveredMessage, RabbitMqService } from '../../../shared/messaging/rabbitmq.service';
import { verificationQueue } from '../../../shared/messaging/topology';
import { VerificationService } from './verification.service';

/** Checks in flight per check type and worker process. */
const PREFETCH = 20;

/**
 * Each check type has its own queue bound to `application.submitted`, so the three checks run
 * independently and in parallel: a slow or failing provider never holds up the others.
 */
@Injectable()
export class VerificationConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly verification: VerificationService,
  ) {}

  onApplicationBootstrap(): void {
    for (const type of ALL_CHECK_TYPES) {
      this.rabbit.consume<ApplicationSubmittedEvent>(verificationQueue(type), PREFETCH, (message) =>
        this.handle(type, message),
      );
    }
  }

  async handle(
    type: CheckType,
    message: DeliveredMessage<ApplicationSubmittedEvent>,
  ): Promise<void> {
    const { payload, attempt, isLastAttempt } = message;
    try {
      await this.verification.runCheck(payload.applicationId, type, { attempt, isLastAttempt });
    } catch (err) {
      if (!isLastAttempt) throw err; // retried with backoff
      await this.verification.giveUp(payload.applicationId, type, attempt, err as Error);
    }
  }
}
