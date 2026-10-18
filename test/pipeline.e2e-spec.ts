import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { ApplicationsRepository } from '../src/shared/applications/applications.repository';
import { outboxMessage, RoutingKey } from '../src/shared/messaging/events';
import { DEAD_LETTER_QUEUE, EVENTS_EXCHANGE } from '../src/shared/messaging/topology';
import { E2E_ENV } from './e2e-env';
import { Harness, identifiers, sleep, startHarness, submit, waitForDecision } from './harness';

const APPROVED = 'approved_for_risk_assessment';
const REJECTED = 'rejected';
const REVIEW = 'requires_manual_compliance_review';

interface Scenario {
  name: string;
  digits?: { nafath?: string; simah?: string; wathiq?: string };
  amount?: number;
  decision: string;
  reasons: string[];
  check?: { type: string; status: string; attempts?: number };
}

/** Same table as the Postman "Verification scenarios" folder (attempts reflect RETRY_ATTEMPTS=3). */
const SCENARIOS: Scenario[] = [
  { name: 'happy path', decision: APPROVED, reasons: ['ALL_CHECKS_PASSED'] },
  {
    name: 'Nafath flaky',
    digits: { nafath: '2' },
    decision: APPROVED,
    reasons: ['ALL_CHECKS_PASSED'],
    check: { type: 'identity', status: 'verified', attempts: 3 },
  },
  {
    name: 'Nafath not verified',
    digits: { nafath: '1' },
    decision: REJECTED,
    reasons: ['IDENTITY_NOT_VERIFIED'],
  },
  {
    name: 'Nafath pending confirmation',
    digits: { nafath: '3' },
    decision: REVIEW,
    reasons: ['IDENTITY_STATUS_INCONCLUSIVE'],
  },
  {
    name: 'Nafath down',
    digits: { nafath: '4' },
    decision: REVIEW,
    reasons: ['IDENTITY_UNAVAILABLE'],
    check: { type: 'identity', status: 'unavailable', attempts: 3 },
  },
  {
    name: 'Wathiq CR expired',
    digits: { wathiq: '1' },
    decision: REJECTED,
    reasons: ['CR_EXPIRED'],
  },
  {
    name: 'Wathiq slow',
    digits: { wathiq: '2' },
    decision: APPROVED,
    reasons: ['ALL_CHECKS_PASSED'],
    check: { type: 'commercial_registration', status: 'verified', attempts: 2 },
  },
  {
    name: 'Wathiq hanging',
    digits: { wathiq: '3' },
    decision: REVIEW,
    reasons: ['CR_UNAVAILABLE'],
    check: { type: 'commercial_registration', status: 'unavailable', attempts: 3 },
  },
  {
    name: 'Wathiq CR not found',
    digits: { wathiq: '4' },
    decision: REJECTED,
    reasons: ['CR_NOT_FOUND'],
  },
  {
    name: 'Wathiq maintenance page',
    digits: { wathiq: '5' },
    decision: REVIEW,
    reasons: ['CR_UNEXPECTED_RESPONSE'],
  },
  {
    name: 'SIMAH poor score',
    digits: { simah: '1' },
    decision: REJECTED,
    reasons: ['CREDIT_SCORE_BELOW_MINIMUM'],
  },
  {
    name: 'SIMAH flaky',
    digits: { simah: '2' },
    decision: APPROVED,
    reasons: ['ALL_CHECKS_PASSED'],
    check: { type: 'credit', status: 'verified', attempts: 3 },
  },
  {
    name: 'SIMAH down',
    digits: { simah: '3' },
    decision: REVIEW,
    reasons: ['CREDIT_UNAVAILABLE'],
    check: { type: 'credit', status: 'unavailable', attempts: 3 },
  },
  {
    name: 'SIMAH borderline score',
    digits: { simah: '4' },
    decision: REVIEW,
    reasons: ['CREDIT_SCORE_BORDERLINE'],
  },
  {
    name: 'SIMAH active defaults',
    digits: { simah: '5' },
    decision: REJECTED,
    reasons: ['CREDIT_ACTIVE_DEFAULTS'],
  },
  {
    name: 'SIMAH no credit file',
    digits: { simah: '6' },
    decision: REVIEW,
    reasons: ['CREDIT_NO_RECORD'],
  },
  {
    name: 'amount above the auto-processing limit',
    amount: 1_500_000,
    decision: REVIEW,
    reasons: ['AMOUNT_ABOVE_AUTO_PROCESSING_LIMIT'],
  },
  {
    name: 'expired CR and Nafath down (rejection wins)',
    digits: { nafath: '4', wathiq: '1' },
    decision: REJECTED,
    reasons: ['CR_EXPIRED'],
  },
];

/** The event-driven pipeline end to end: API -> RabbitMQ -> worker -> mocks -> decision. */
describe('Verification pipeline (e2e)', () => {
  let h: Harness;
  let broker: Awaited<ReturnType<typeof amqp.connect>>;
  let channel: amqp.Channel;

  beforeAll(async () => {
    h = await startHarness();
    broker = await amqp.connect(E2E_ENV.RABBITMQ_URL);
    channel = await broker.createChannel();
  });

  afterAll(async () => {
    await channel?.close();
    await broker?.close();
    await h?.close();
  });

  const get = (id: string) =>
    h.http.get(`/applications/${id}`).set('Authorization', `Bearer ${h.token}`).expect(200);

  describe('scenarios', () => {
    it.each(SCENARIOS)('$name -> $decision', async (s) => {
      const { body } = await submit(h, {
        ...identifiers(s.digits),
        requestedAmount: s.amount ?? 250_000,
      }).expect(202);
      await waitForDecision(h, body.id);

      const { body: app } = await get(body.id);
      expect(app.status).toBe('decided');
      expect(app.decision).toBe(s.decision);
      expect(app.decisionReasons).toEqual(expect.arrayContaining(s.reasons));
      expect(app.decisionReasons).toHaveLength(s.reasons.length);
      if (s.check) {
        const check = app.checks.find((c: { type: string }) => c.type === s.check!.type);
        expect(check.status).toBe(s.check.status);
        if (s.check.attempts) expect(check.attempts).toBe(s.check.attempts);
      }
    });
  });

  describe('data at rest', () => {
    it('stores identifiers and provider replies encrypted only', async () => {
      const ids = identifiers();
      const { body } = await submit(h, { ...ids, requestedAmount: 250_000 }).expect(202);
      await waitForDecision(h, body.id);

      const row = await h.prisma.application.findUniqueOrThrow({ where: { id: body.id } });
      const dbRow = JSON.stringify(row);
      expect(dbRow).not.toContain(ids.nationalId);
      expect(dbRow).not.toContain(ids.crNumber);

      const checks = await h.prisma.verificationCheck.findMany({
        where: { applicationId: body.id },
      });
      expect(JSON.stringify(checks)).not.toMatch(/VERIFIED|ACTIVE|"score"/);

      const outbox = await h.prisma.outboxEvent.findMany({ where: { aggregateId: body.id } });
      expect(JSON.stringify(outbox)).not.toContain(ids.nationalId);
    });
  });

  describe('outbox', () => {
    it('publishes every event of a decided application', async () => {
      const { body } = await submit(h, { ...identifiers(), requestedAmount: 250_000 }).expect(202);
      await waitForDecision(h, body.id);

      // application.decided is committed with the decision and marked published right after it.
      let events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: body.id } });
      for (let i = 0; i < 20 && events.some((e) => e.publishedAt === null); i++) {
        await sleep(100);
        events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: body.id } });
      }
      expect(events.map((e) => e.routingKey).sort()).toEqual([
        RoutingKey.applicationDecided,
        RoutingKey.applicationSubmitted,
        RoutingKey.checkCompleted,
        RoutingKey.checkCompleted,
        RoutingKey.checkCompleted,
      ]);
      expect(events.every((e) => e.publishedAt !== null)).toBe(true);
    });

    it('relays an event that was committed but never published', async () => {
      // Simulates a crash between the database commit and the publish: store the application and
      // its outbox row exactly as the API does, but skip publishNow.
      const id = randomUUID();
      const event = outboxMessage(RoutingKey.applicationSubmitted, id, { applicationId: id });
      await h.api.get(ApplicationsRepository).create(
        {
          id,
          clientId: E2E_ENV.DEMO_CLIENT_ID,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
          ...identifiers(),
          requestedAmount: 250_000,
        },
        event,
      );

      await waitForDecision(h, id);
      const row = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.publishedAt).not.toBeNull();
    });
  });

  describe('messaging guarantees', () => {
    it('ignores duplicate check.completed events after the decision', async () => {
      const { body } = await submit(h, { ...identifiers(), requestedAmount: 250_000 }).expect(202);
      await waitForDecision(h, body.id);

      for (let i = 0; i < 3; i++) {
        channel.publish(
          EVENTS_EXCHANGE,
          RoutingKey.checkCompleted,
          Buffer.from(
            JSON.stringify({ applicationId: body.id, checkType: 'credit', status: 'verified' }),
          ),
          { persistent: true },
        );
      }
      await sleep(1000);

      const decided = await h.prisma.auditEvent.count({
        where: { applicationId: body.id, event: 'APPLICATION_DECIDED' },
      });
      expect(decided).toBe(1);
    });

    it('dead-letters a message that cannot be parsed', async () => {
      await channel.purgeQueue(DEAD_LETTER_QUEUE);
      channel.publish(EVENTS_EXCHANGE, RoutingKey.applicationSubmitted, Buffer.from('not json'), {
        persistent: true,
        messageId: 'poison',
      });

      // One copy per verification queue bound to application.submitted.
      let deadLettered = 0;
      for (let i = 0; i < 30 && deadLettered < 3; i++) {
        await sleep(100);
        deadLettered = (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount;
      }
      expect(deadLettered).toBe(3);
      await channel.purgeQueue(DEAD_LETTER_QUEUE);
    });
  });

  // Kept last: it opens the SIMAH circuit (threshold 4, cooldown 1 s in e2e-env.ts).
  describe('circuit breaker', () => {
    it('fails fast while SIMAH is down, then recovers after the cooldown', async () => {
      const submitted = await Promise.all(
        [1, 2, 3].map(() =>
          submit(h, { ...identifiers({ simah: '3' }), requestedAmount: 250_000 }).expect(202),
        ),
      );
      const ids = submitted.map((res) => res.body.id as string);
      await Promise.all(ids.map((id) => waitForDecision(h, id)));

      // Every application still gets a safe decision...
      for (const id of ids) {
        const { body } = await get(id);
        expect(body.decision).toBe(REVIEW);
        expect(body.decisionReasons).toEqual(['CREDIT_UNAVAILABLE']);
      }
      // ...and after 4 consecutive 503s the remaining attempts never reached SIMAH.
      const shortCircuited = await h.prisma.auditEvent.count({
        where: {
          applicationId: { in: ids },
          metadata: { path: ['error'], equals: 'CIRCUIT_OPEN' },
        },
      });
      expect(shortCircuited).toBeGreaterThan(0);

      // After the cooldown, a trial call succeeds and the circuit closes again.
      await sleep(1100);
      const { body } = await submit(h, { ...identifiers(), requestedAmount: 250_000 }).expect(202);
      await waitForDecision(h, body.id);
      expect((await get(body.id)).body.decision).toBe(APPROVED);
    });
  });
});
