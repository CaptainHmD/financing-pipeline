import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/apps/api/app.module';
import { setupApp } from '../src/apps/api/setup-app';
import { WorkerModule } from '../src/apps/worker/worker.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { E2E_ENV, E2E_PORT } from './e2e-env';

export type Http = ReturnType<typeof request>;

/** The real API (listening, so the worker can reach its mocks) and the real worker, in-process. */
export interface Harness {
  api: INestApplication;
  worker: INestApplicationContext;
  http: Http;
  prisma: PrismaService;
  token: string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const api = await NestFactory.create(AppModule, { logger: ['error'] });
  setupApp(api);
  await api.listen(E2E_PORT);
  const worker = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });

  const http = request(api.getHttpServer());
  const { body } = await http
    .post('/auth/token')
    .send({ clientId: E2E_ENV.DEMO_CLIENT_ID, clientSecret: E2E_ENV.DEMO_CLIENT_SECRET })
    .expect(200);

  return {
    api,
    worker,
    http,
    prisma: api.get(PrismaService),
    token: body.accessToken as string,
    async close() {
      await worker.close();
      await api.close();
    },
  };
}

/** Digits pick the mock scenario; the rest is random so open applications never collide. */
export function identifiers(digits: { nafath?: string; simah?: string; wathiq?: string } = {}) {
  const rnd = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  return {
    nationalId: `1${rnd(7)}${digits.simah ?? '0'}${digits.nafath ?? '0'}`,
    crNumber: `7${rnd(8)}${digits.wathiq ?? '0'}`,
  };
}

export function submit(
  h: Harness,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
) {
  return h.http
    .post('/applications')
    .set('Authorization', `Bearer ${h.token}`)
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
}

/** Polls the database (not the API, to stay clear of the rate limit) until the application is decided. */
export async function waitForDecision(h: Harness, id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await h.prisma.application.findUnique({ where: { id }, select: { status: true } });
    if (row?.status === 'decided') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Application ${id} was not decided within ${timeoutMs} ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
