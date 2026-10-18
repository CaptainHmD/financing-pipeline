import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ApplicationStatus,
  CheckStatus,
  CheckType,
  FINAL_CHECK_STATUSES,
} from '../../../shared/applications/application.types';
import { ApplicationsRepository } from '../../../shared/applications/applications.repository';
import { CheckCompletedEvent, outboxMessage, RoutingKey } from '../../../shared/messaging/events';
import { OutboxService } from '../../../shared/messaging/outbox.service';
import {
  TransientGatewayError,
  VERIFICATION_GATEWAYS,
  VerificationGateway,
} from './gateways/gateway.types';
import { VerificationRepository } from './verification.repository';

export interface AttemptContext {
  attempt: number;
  isLastAttempt: boolean;
}

export type CheckRunResult = 'completed' | 'skipped' | 'unavailable';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private readonly gateways: Map<CheckType, VerificationGateway>;

  constructor(
    @Inject(VERIFICATION_GATEWAYS) gateways: VerificationGateway[],
    private readonly checks: VerificationRepository,
    private readonly applications: ApplicationsRepository,
    private readonly outbox: OutboxService,
  ) {
    this.gateways = new Map(gateways.map((g) => [g.checkType, g]));
  }

  /**
   * Runs one attempt of one check.
   * - Definitive or ambiguous answers are recorded, and `check.completed` is published.
   * - Transient failures are recorded as `retrying` and rethrown so the message is retried with backoff.
   * - On the last attempt a transient failure becomes `unavailable` (a recorded fact, not an exception),
   *   so the decision step always gets a complete picture.
   */
  async runCheck(
    applicationId: string,
    type: CheckType,
    ctx: AttemptContext,
  ): Promise<CheckRunResult> {
    const current = await this.checks.findStatus(applicationId, type);
    if (current === null) {
      this.logger.error(`No ${type} check exists for application ${applicationId}`);
      return 'skipped';
    }
    // Redelivered message: already done, and its event is guaranteed by the outbox.
    if (FINAL_CHECK_STATUSES.includes(current)) return 'skipped';

    const application = await this.applications.findById(applicationId);
    if (!application) return 'skipped';
    if (application.status === ApplicationStatus.submitted) {
      await this.applications.markVerifying(applicationId);
    }

    const gateway = this.gateways.get(type);
    if (!gateway) throw new Error(`No gateway registered for ${type}`);

    const started = Date.now();
    try {
      const outcome = await gateway.verify({
        applicationId,
        nationalId: application.nationalId,
        crNumber: application.crNumber,
      });
      const event = completedEvent(applicationId, type, outcome.status);
      await this.checks.recordOutcome(
        applicationId,
        type,
        outcome,
        { attempt: ctx.attempt, latencyMs: Date.now() - started },
        event,
      );
      await this.outbox.publishNow(event);
      return 'completed';
    } catch (err) {
      if (!(err instanceof TransientGatewayError)) throw err;
      const info = { attempt: ctx.attempt, latencyMs: Date.now() - started };
      if (ctx.isLastAttempt) {
        this.logger.warn(
          `${type} for ${applicationId} unavailable after ${ctx.attempt} attempts (${err.code})`,
        );
        const event = completedEvent(applicationId, type, CheckStatus.unavailable);
        await this.checks.markUnavailable(applicationId, type, err.code, info, event);
        await this.outbox.publishNow(event);
        return 'unavailable';
      }
      this.logger.warn(
        `${type} for ${applicationId} attempt ${ctx.attempt} failed (${err.code}), retrying`,
      );
      await this.checks.markRetrying(applicationId, type, err.code, info);
      throw err;
    }
  }

  /**
   * Last resort when the final attempt failed for a reason other than the provider (a bug, a DB
   * outage): record the check as unavailable so the application still reaches a decision.
   */
  async giveUp(applicationId: string, type: CheckType, attempt: number, err: Error): Promise<void> {
    const current = await this.checks.findStatus(applicationId, type);
    if (current === null || FINAL_CHECK_STATUSES.includes(current)) return;
    this.logger.error(
      `${type} for ${applicationId} failed on its last attempt (${err.message}), marking unavailable`,
    );
    const event = completedEvent(applicationId, type, CheckStatus.unavailable);
    await this.checks.markUnavailable(
      applicationId,
      type,
      'PROCESSING_ERROR',
      { attempt, latencyMs: 0 },
      event,
    );
    await this.outbox.publishNow(event);
  }
}

function completedEvent(applicationId: string, checkType: CheckType, status: CheckStatus) {
  return outboxMessage<CheckCompletedEvent>(RoutingKey.checkCompleted, applicationId, {
    applicationId,
    checkType,
    status,
  });
}
