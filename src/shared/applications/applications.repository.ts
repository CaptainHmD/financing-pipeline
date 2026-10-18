import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { OutboxMessage } from '../messaging/events';
import { OutboxService } from '../messaging/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_CHECK_TYPES,
  allowedSourcesFor,
  ApplicationRecord,
  ApplicationStatus,
  Decision,
  NewApplication,
} from './application.types';

const withChecks = { checks: { orderBy: { type: 'asc' } } } satisfies Prisma.ApplicationInclude;
type ApplicationRow = Prisma.ApplicationGetPayload<{ include: typeof withChecks }>;

/** Owns persistence of the Application aggregate; PII is encrypted/decrypted at this boundary. */
@Injectable()
export class ApplicationsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async findById(id: string): Promise<ApplicationRecord | null> {
    const row = await this.prisma.application.findUnique({ where: { id }, include: withChecks });
    return row ? this.toRecord(row) : null;
  }

  async findForClient(id: string, clientId: string): Promise<ApplicationRecord | null> {
    const row = await this.prisma.application.findFirst({
      where: { id, clientId },
      include: withChecks,
    });
    return row ? this.toRecord(row) : null;
  }

  async findByIdempotencyKey(
    clientId: string,
    idempotencyKey: string,
  ): Promise<ApplicationRecord | null> {
    const row = await this.prisma.application.findUnique({
      where: { clientId_idempotencyKey: { clientId, idempotencyKey } },
      include: withChecks,
    });
    return row ? this.toRecord(row) : null;
  }

  /** Is there an undecided application for the same applicant + CR? Uses blind indexes only. */
  async hasOpenApplication(nationalId: string, crNumber: string): Promise<boolean> {
    const count = await this.prisma.application.count({
      where: {
        nationalIdHash: this.crypto.blindIndex(nationalId),
        crNumberHash: this.crypto.blindIndex(crNumber),
        status: { not: ApplicationStatus.decided },
      },
    });
    return count > 0;
  }

  /**
   * Persists the application, its pending checks, the first audit event and the
   * `application.submitted` outbox event atomically.
   * Returns null when the idempotency key was taken concurrently (unique violation).
   */
  async create(input: NewApplication, event: OutboxMessage): Promise<ApplicationRecord | null> {
    try {
      const [row] = await this.prisma.$transaction([
        this.prisma.application.create({
          data: {
            id: input.id,
            clientId: input.clientId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            nationalIdEnc: this.crypto.encrypt(input.nationalId),
            nationalIdHash: this.crypto.blindIndex(input.nationalId),
            crNumberEnc: this.crypto.encrypt(input.crNumber),
            crNumberHash: this.crypto.blindIndex(input.crNumber),
            requestedAmount: new Prisma.Decimal(input.requestedAmount),
            checks: { create: ALL_CHECK_TYPES.map((type) => ({ type })) },
            events: { create: { event: 'APPLICATION_SUBMITTED' } },
          },
          include: withChecks,
        }),
        this.prisma.outboxEvent.create({ data: OutboxService.toRow(event) }),
      ]);
      return this.toRecord(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Compare-and-set transition; returns false if the application was not in an allowed source state.
   * The audit event and the optional outbox event are written only when the transition applied.
   */
  async transition(
    id: string,
    to: ApplicationStatus,
    event: string,
    data: Omit<Prisma.ApplicationUpdateManyMutationInput, 'status'> = {},
    metadata: Prisma.InputJsonObject = {},
    outbox?: OutboxMessage,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.application.updateMany({
        where: { id, status: { in: allowedSourcesFor(to) } },
        data: { ...data, status: to },
      });
      if (count === 1) {
        await tx.auditEvent.create({ data: { applicationId: id, event, metadata } });
        if (outbox) await tx.outboxEvent.create({ data: OutboxService.toRow(outbox) });
      }
      return count === 1;
    });
  }

  markVerifying(id: string): Promise<boolean> {
    return this.transition(id, ApplicationStatus.verifying, 'VERIFICATION_STARTED');
  }

  recordDecision(
    id: string,
    decision: Decision,
    reasons: string[],
    event: OutboxMessage,
  ): Promise<boolean> {
    return this.transition(
      id,
      ApplicationStatus.decided,
      'APPLICATION_DECIDED',
      { decision, decisionReasons: reasons, decidedAt: new Date() },
      { decision, reasons },
      event,
    );
  }

  async listEvents(id: string, clientId: string) {
    const owned = await this.prisma.application.count({ where: { id, clientId } });
    if (!owned) return null;
    return this.prisma.auditEvent.findMany({
      where: { applicationId: id },
      orderBy: { id: 'asc' },
      select: { event: true, metadata: true, createdAt: true },
    });
  }

  private toRecord(row: ApplicationRow): ApplicationRecord {
    return {
      id: row.id,
      clientId: row.clientId,
      requestHash: row.requestHash,
      nationalId: this.crypto.decrypt(row.nationalIdEnc),
      crNumber: this.crypto.decrypt(row.crNumberEnc),
      requestedAmount: row.requestedAmount.toNumber(),
      status: row.status,
      decision: row.decision,
      decisionReasons: row.decisionReasons,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      checks: row.checks.map((c) => ({
        type: c.type,
        status: c.status,
        attempts: c.attempts,
        reasonCode: c.reasonCode,
        lastError: c.lastError,
        latencyMs: c.latencyMs,
        completedAt: c.completedAt,
      })),
    };
  }
}
