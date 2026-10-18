import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { E2E_ENV } from './e2e-env';
import { Harness, identifiers, startHarness, submit, waitForDecision } from './harness';

/** The HTTP contract: auth, validation, idempotency, tenant isolation and the audit trail. */
describe('API (e2e)', () => {
  let h: Harness;
  const amount = 250_000;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('operations', () => {
    it('GET /health answers ok', async () => {
      await h.http.get('/health').expect(200, { status: 'ok' });
    });

    it('serves the OpenAPI document', async () => {
      const { body } = await h.http.get('/docs/openapi.json').expect(200);
      expect(Object.keys(body.paths)).toEqual(
        expect.arrayContaining(['/applications', '/applications/{id}', '/auth/token']),
      );
    });
  });

  describe('POST /auth/token', () => {
    it('rejects a wrong secret', async () => {
      await h.http
        .post('/auth/token')
        .send({ clientId: E2E_ENV.DEMO_CLIENT_ID, clientSecret: 'wrong' })
        .expect(401);
    });

    it('rejects a missing secret', async () => {
      await h.http.post('/auth/token').send({ clientId: E2E_ENV.DEMO_CLIENT_ID }).expect(400);
    });
  });

  describe('authentication', () => {
    it('requires a bearer token', async () => {
      await h.http
        .post('/applications')
        .set('Idempotency-Key', randomUUID())
        .send({ ...identifiers(), requestedAmount: amount })
        .expect(401);
    });

    it('rejects an invalid token', async () => {
      await h.http
        .get(`/applications/${randomUUID()}`)
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('POST /applications', () => {
    it('accepts an application, masks PII and points to it', async () => {
      const ids = identifiers();
      const res = await submit(h, { ...ids, requestedAmount: amount }).expect(202);

      expect(res.headers.location).toBe(`/applications/${res.body.id}`);
      expect(res.body).toMatchObject({
        status: 'submitted',
        decision: null,
        requestedAmount: amount,
      });
      expect(res.body.nationalId).toBe(`${ids.nationalId[0]}*******${ids.nationalId.slice(-2)}`);
      expect(res.body.crNumber).toBe(`${ids.crNumber[0]}*******${ids.crNumber.slice(-2)}`);
      expect(res.body.checks.map((c: { type: string }) => c.type).sort()).toEqual([
        'commercial_registration',
        'credit',
        'identity',
      ]);
    });

    it('replays the original application for the same key and payload', async () => {
      const key = randomUUID();
      const body = { ...identifiers(), requestedAmount: amount };
      const first = await submit(h, body, key).expect(202);
      const replay = await submit(h, body, key).expect(202);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(first.body.id);
      expect(await h.prisma.application.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    it('rejects the same key with a different payload', async () => {
      const key = randomUUID();
      const ids = identifiers();
      await submit(h, { ...ids, requestedAmount: amount }, key).expect(202);
      await submit(h, { ...ids, requestedAmount: amount + 1 }, key).expect(409);
    });

    it('rejects a second application while one is open for the same ID and CR', async () => {
      const ids = identifiers({ wathiq: '3' }); // CR check hangs, so the first stays open for a while
      await submit(h, { ...ids, requestedAmount: amount }).expect(202);
      await submit(h, { ...ids, requestedAmount: amount }).expect(409);
    });

    it('requires a valid Idempotency-Key', async () => {
      const body = { ...identifiers(), requestedAmount: amount };
      await h.http
        .post('/applications')
        .set('Authorization', `Bearer ${h.token}`)
        .send(body)
        .expect(400);
      await submit(h, body, 'short').expect(400);
    });

    it('reports every invalid field and rejects unknown ones', async () => {
      const { body } = await submit(h, {
        nationalId: '3123',
        crNumber: 'abc',
        requestedAmount: 500,
        unexpectedField: true,
      }).expect(400);
      const messages = (body.message as string[]).join(' | ');
      for (const field of ['nationalId', 'crNumber', 'requestedAmount', 'unexpectedField']) {
        expect(messages).toContain(field);
      }
    });
  });

  describe('GET /applications/:id', () => {
    it('rejects a malformed id', async () => {
      await h.http
        .get('/applications/not-a-uuid')
        .set('Authorization', `Bearer ${h.token}`)
        .expect(400);
    });

    it('returns 404 for an unknown id', async () => {
      await h.http
        .get(`/applications/${randomUUID()}`)
        .set('Authorization', `Bearer ${h.token}`)
        .expect(404);
    });

    it("hides another client's application", async () => {
      const { body } = await submit(h, { ...identifiers(), requestedAmount: amount }).expect(202);
      const otherToken = await h.api.get(JwtService).signAsync({ sub: 'another-client' });
      await h.http
        .get(`/applications/${body.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      await h.http
        .get(`/applications/${body.id}/events`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });
  });

  describe('GET /applications/:id/events', () => {
    it('records every step of the pipeline without raw identifiers', async () => {
      const ids = identifiers({ simah: '2' }); // SIMAH fails twice, so retries show up
      const { body } = await submit(h, { ...ids, requestedAmount: amount }).expect(202);
      await waitForDecision(h, body.id);

      const events = await h.http
        .get(`/applications/${body.id}/events`)
        .set('Authorization', `Bearer ${h.token}`)
        .expect(200);
      const names = (events.body as { event: string }[]).map((e) => e.event);

      expect(names[0]).toBe('APPLICATION_SUBMITTED');
      expect(names).toContain('VERIFICATION_STARTED');
      expect(names.filter((n) => n === 'CHECK_RETRY_SCHEDULED')).toHaveLength(2);
      expect(names.filter((n) => n === 'CHECK_COMPLETED')).toHaveLength(3);
      expect(names.at(-1)).toBe('APPLICATION_DECIDED');

      const raw = JSON.stringify(events.body);
      expect(raw).not.toContain(ids.nationalId);
      expect(raw).not.toContain(ids.crNumber);
    });
  });
});
