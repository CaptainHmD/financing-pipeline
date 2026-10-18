import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CheckStatus, CheckType } from '../../../shared/applications/application.types';
import { CryptoService } from '../../../shared/crypto/crypto.service';
import { OutboxMessage } from '../../../shared/messaging/events';
import { OutboxService } from '../../../shared/messaging/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { GatewayOutcome } from './gateways/gateway.types';

export interface CheckState {
  type: CheckType;
  status: CheckStatus;
  reasonCode: string | null;
  data: Record<string, unknown> | null;
}

interface AttemptInfo {
  attempt: number;
  latencyMs: number;
}

/**
 * Persists check outcomes; provider payloads are stored encrypted. Each write is audited, and a
 * final outcome also writes its `check.completed` outbox event in the same transaction.
 */
@Injectable()
export class VerificationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async findStatus(applicationId: string, type: CheckType): Promise<CheckStatus | null> {
    const check = await this.prisma.verificationCheck.findUnique({
      where: { applicationId_type: { applicationId, type } },
      select: { status: true },
    });
    return check?.status ?? null;
  }

  async findAll(applicationId: string): Promise<CheckState[]> {
    const checks = await this.prisma.verificationCheck.findMany({ where: { applicationId } });
    return checks.map((c) => ({
      type: c.type,
      status: c.status,
      reasonCode: c.reasonCode,
      data: c.resultPayloadEnc
        ? this.crypto.decryptJson<Record<string, unknown>>(c.resultPayloadEnc)
        : null,
    }));
  }

  recordOutcome(
    applicationId: string,
    type: CheckType,
    outcome: GatewayOutcome,
    info: AttemptInfo,
    event: OutboxMessage,
  ): Promise<void> {
    const data = 'data' in outcome && outcome.data ? outcome.data : null;
    return this.update(
      applicationId,
      type,
      {
        status: outcome.status,
        reasonCode: 'reasonCode' in outcome ? outcome.reasonCode : null,
        resultPayloadEnc: data ? this.crypto.encryptJson(data) : null,
        completedAt: new Date(),
      },
      info,
      'CHECK_COMPLETED',
      {
        status: outcome.status,
        ...('reasonCode' in outcome && { reasonCode: outcome.reasonCode }),
      },
      event,
    );
  }

  markRetrying(applicationId: string, type: CheckType, error: string, info: AttemptInfo) {
    return this.update(
      applicationId,
      type,
      { status: CheckStatus.retrying, lastError: error },
      info,
      'CHECK_RETRY_SCHEDULED',
      { error },
    );
  }

  markUnavailable(
    applicationId: string,
    type: CheckType,
    error: string,
    info: AttemptInfo,
    event: OutboxMessage,
  ) {
    return this.update(
      applicationId,
      type,
      {
        status: CheckStatus.unavailable,
        lastError: error,
        reasonCode: 'RETRIES_EXHAUSTED',
        completedAt: new Date(),
      },
      info,
      'CHECK_UNAVAILABLE',
      { error },
      event,
    );
  }

  private async update(
    applicationId: string,
    type: CheckType,
    data: Prisma.VerificationCheckUpdateInput,
    info: AttemptInfo,
    event: string,
    metadata: Prisma.InputJsonObject,
    outbox?: OutboxMessage,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.verificationCheck.update({
        where: { applicationId_type: { applicationId, type } },
        data: { ...data, attempts: info.attempt, latencyMs: info.latencyMs },
      }),
      this.prisma.auditEvent.create({
        data: {
          applicationId,
          event,
          metadata: {
            checkType: type,
            attempt: info.attempt,
            latencyMs: info.latencyMs,
            ...metadata,
          },
        },
      }),
      ...(outbox ? [this.prisma.outboxEvent.create({ data: OutboxService.toRow(outbox) })] : []),
    ]);
  }
}
