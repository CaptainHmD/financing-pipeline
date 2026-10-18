import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  ALL_CHECK_TYPES,
  ApplicationStatus,
  FINAL_CHECK_STATUSES,
} from '../../../shared/applications/application.types';
import { ApplicationsRepository } from '../../../shared/applications/applications.repository';
import {
  ApplicationDecidedEvent,
  CheckCompletedEvent,
  outboxMessage,
  RoutingKey,
} from '../../../shared/messaging/events';
import { OutboxService } from '../../../shared/messaging/outbox.service';
import { RabbitMqService } from '../../../shared/messaging/rabbitmq.service';
import { DECISION_QUEUE } from '../../../shared/messaging/topology';
import { VerificationRepository } from '../verification/verification.repository';
import { DecisionService } from './decision.service';

const PREFETCH = 10;

/**
 * Fan-in: reacts to every `check.completed` and decides once all three checks are final.
 * Each check commits before its event is published, so whichever event arrives last sees all
 * three results. Concurrent or duplicate events are harmless: the decided transition is a
 * compare-and-set, so only one decision (and one `application.decided` event) is ever recorded.
 */
@Injectable()
export class DecisionConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DecisionConsumer.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly outbox: OutboxService,
    private readonly applications: ApplicationsRepository,
    private readonly checks: VerificationRepository,
    private readonly decisions: DecisionService,
  ) {}

  onApplicationBootstrap(): void {
    this.rabbit.consume<CheckCompletedEvent>(DECISION_QUEUE, PREFETCH, ({ payload }) =>
      this.onCheckCompleted(payload),
    );
  }

  async onCheckCompleted({ applicationId }: CheckCompletedEvent): Promise<void> {
    const application = await this.applications.findById(applicationId);
    if (!application || application.status === ApplicationStatus.decided) return;

    const checks = await this.checks.findAll(applicationId);
    const settled = checks.filter((c) => FINAL_CHECK_STATUSES.includes(c.status));
    if (settled.length < ALL_CHECK_TYPES.length) return; // wait for the remaining checks

    const result = this.decisions.decide({ requestedAmount: application.requestedAmount, checks });
    const event = outboxMessage<ApplicationDecidedEvent>(
      RoutingKey.applicationDecided,
      applicationId,
      {
        applicationId,
        decision: result.decision,
        reasons: result.reasons,
      },
    );
    if (
      await this.applications.recordDecision(applicationId, result.decision, result.reasons, event)
    ) {
      this.logger.log(
        `Application ${applicationId} -> ${result.decision} [${result.reasons.join(', ')}]`,
      );
      await this.outbox.publishNow(event);
    }
  }
}
