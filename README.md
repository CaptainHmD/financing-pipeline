# Financing API

A backend for a small-business financing pipeline. A partner submits an application. The system then verifies the owner's identity (Nafath/Yakeen), the business's Commercial Registration (Wathiq) and the owner's credit history (SIMAH), and returns a screening decision.

The three providers are mocked inside the app, and specific digits in the submitted IDs make them succeed, fail, time out or return broken responses. That makes every failure path reproducible from Postman or a test.

**Stack:** NestJS 11 · TypeScript · PostgreSQL 16 (Prisma) · RabbitMQ 4 · Jest + Supertest · Docker Compose

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API](#api)
- [Mock provider scenarios](#mock-provider-scenarios)
- [Decision rules](#decision-rules)
- [Reliability](#reliability)
- [Security](#security)
- [Testing](#testing)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Trade-offs and next steps](#trade-offs-and-next-steps)

## Quick start

Requires Docker. For local development you also need Node.js 22+.

### Everything in Docker

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3001 |
| Swagger UI | http://localhost:3001/docs |
| RabbitMQ management | http://localhost:15672 (`app` / `app`) |

The API container applies the database migrations before it starts.

### Local development

```bash
cp .env.example .env
npm install
docker compose up -d postgres rabbitmq
npx prisma migrate deploy
npm run start:dev          # terminal 1: API
npm run start:worker:dev   # terminal 2: worker
```

> If you change `PORT`, set `GATEWAY_BASE_URL` to the same port (`http://localhost:<PORT>/mock`). The worker calls the mock providers through the API.
>
> If another RabbitMQ already listens on 5672, the worker logs `Cannot connect to RabbitMQ … ACCESS_REFUSED` and events wait in the outbox. Stop the other broker, or map this one to a free port and change `RABBITMQ_URL` to match.

### Try it

```bash
TOKEN=$(curl -s -X POST localhost:3001/auth/token -H 'Content-Type: application/json' \
  -d '{"clientId":"demo-client","clientSecret":"demo-client-secret"}' | jq -r .accessToken)

curl -s -X POST localhost:3001/applications \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"nationalId":"1012345600","crNumber":"7001234560","requestedAmount":250000}'

# poll until "status": "decided"
curl -s localhost:3001/applications/<id> -H "Authorization: Bearer $TOKEN"
```

## How it works

The app runs as two processes built from one codebase:

- The **API** accepts requests, stores applications and publishes events. It never calls a provider.
- The **worker** reacts to events: it runs the checks against the providers and makes the decision.

The two processes never call each other. They share PostgreSQL and talk only through events on RabbitMQ.

```mermaid
flowchart LR
  C[Client] -->|POST /applications| API
  API -->|application + outbox row<br/>one transaction| DB[(PostgreSQL)]
  API -->|application.submitted| X{{financing.events<br/>topic exchange}}
  X --> QI[verification.identity]
  X --> QC[verification.commercial_registration]
  X --> QS[verification.credit]
  QI & QC & QS --> W[Worker: check consumers]
  W -->|HTTP| M[Nafath / Wathiq / SIMAH mocks]
  W -->|check.completed| X
  X --> QD[decision]
  QD --> D[Worker: decision consumer]
  D -->|application.decided| X
```

### Life of an application

1. `POST /applications` validates the body and applies idempotency. In one transaction it stores:
   - the application, with the IDs encrypted
   - three `pending` checks
   - an audit event
   - an `application.submitted` row in the outbox

   It returns `202` with status `submitted`.
2. The API publishes the event straight away without waiting for it. If RabbitMQ is down, the worker's outbox relay publishes it later.
3. Each check type has its own queue, so the three checks run in parallel. The first check to start moves the application to `verifying`.
4. A clear answer is recorded as `verified`, `failed` or `ambiguous`, together with a `check.completed` event in the same transaction.
   - A temporary failure (timeout, network error, 5xx, 408 or 429) is retried after 2, 4, 8 and then 16 seconds.
   - If the fifth attempt also fails, the check becomes `unavailable`.
5. The decision consumer receives every `check.completed`. Once all three checks are final, it:
   - applies the rules
   - stores the decision and its reasons
   - moves the application to `decided`
   - emits `application.decided`

### Events

| Routing key | Published by | Consumed by | Payload |
|---|---|---|---|
| `application.submitted` | API | `verification.identity`, `verification.commercial_registration`, `verification.credit` | `applicationId` |
| `check.completed` | Worker | `decision` | `applicationId`, `checkType`, `status` |
| `application.decided` | Worker | Nothing yet. Notifications or risk assessment can subscribe without changes here. | `applicationId`, `decision`, `reasons` |

Events carry identifiers only. Consumers read and decrypt what they need from the database, so no personal data passes through the broker.

| Exchange / queue | Purpose |
|---|---|
| `financing.events` (topic) | All domain events |
| `verification.*`, `decision` (quorum) | One durable queue per consumer |
| `financing.retry` → `financing.retry.<delay>ms` | Delay queues with a TTL. A failed message waits there before its next attempt. |
| `financing.requeue` (topic) | Routes an expired retry back to the one queue it came from |
| `financing.dlx` → `financing.dead-letter` | Messages that can't be parsed or that failed every attempt |

## API

Full schemas are in Swagger at `/docs`, and the OpenAPI document is at `/docs/openapi.json`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | – | Liveness probe |
| `POST` | `/auth/token` | – | Demo client-credentials token (JWT, 15 min). Rate-limited to 10 per minute. |
| `POST` | `/applications` | Bearer | Submit an application. Requires an `Idempotency-Key` header. Returns `202`. |
| `GET` | `/applications/{id}` | Bearer | Status, decision, reasons and per-check results |
| `GET` | `/applications/{id}/events` | Bearer | Audit trail |
| `GET` | `/mock/scenarios` | – | Which digit triggers which mock behaviour |
| `POST` | `/mock/nafath/verify` | – | Mock identity provider |
| `POST` | `/mock/wathiq/cr-status` | – | Mock Commercial Registration provider |
| `POST` | `/mock/simah/credit-report` | – | Mock credit bureau |

**Submit body:**
- `nationalId`: 10 digits, starting with 1 (citizen) or 2 (Iqama).
- `crNumber`: 10 digits.
- `requestedAmount`: 10,000 to 5,000,000 SAR.

Unknown fields are rejected.

**Errors** use the NestJS shape `{ statusCode, message, error }`:

| Status | When |
|---|---|
| `400` | Invalid body, or a missing or invalid Idempotency-Key |
| `401` | Missing or invalid token |
| `404` | Unknown application, or one that belongs to another client |
| `409` | An Idempotency-Key reused with a different body, or this National ID and CR already have an application in progress |
| `429` | Rate limit exceeded |

## Mock provider scenarios

| Provider | Selected by | Digit → behaviour |
|---|---|---|
| Nafath/Yakeen | Last digit of `nationalId` | `1` not verified · `2` 503 twice, then verified · `3` pending confirmation (ambiguous) · `4` always 503 · other digits verified |
| Wathiq | Last digit of `crNumber` | `1` expired · `2` first call times out, then active · `3` every call times out · `4` 404 not found · `5` HTML maintenance page · other digits active |
| SIMAH | Second-to-last digit of `nationalId` | `1` score 480 · `2` 503 twice, then 720 · `3` always 503 · `4` score 600 · `5` 2 active defaults · `6` no credit file · other digits score 720 |

For example, `nationalId` `1012345640` combined with `crNumber` `7001234561` gives a borderline credit score (SIMAH digit 4) and an expired CR (Wathiq digit 1). The result is `rejected`, with reason `CR_EXPIRED`.

## Decision rules

The rules are in `src/modules/worker/decision/`. The decision logic is a pure function, and the thresholds are kept as data.

| Decision | When |
|---|---|
| `rejected` | Any definitive negative: identity not verified, CR expired, inactive or not found, a credit score below 550, or any active default. A rejection wins over everything else. |
| `requires_manual_compliance_review` | Nothing to reject, but something is uncertain: a check is ambiguous or unavailable, the credit score is 550 to 649, or the amount is above 1,000,000 SAR |
| `approved_for_risk_assessment` | All three checks are clean. This passes screening; it is not a loan approval. |

A provider outage never rejects an applicant on its own. It sends the application to manual review.

## Reliability

- **Transactional outbox.** Every event is written in the same transaction as the state change it announces, so the database and the broker can't disagree. It's published right after the commit. Anything that didn't go out is published by a relay in the worker every 5 seconds, which covers both a broker outage and a crash between the commit and the publish.
- **Idempotent submit.**
  - The same key with the same body returns the original application, with the header `Idempotent-Replayed: true`.
  - The same key with a different body gets `409`.
  - When two identical requests race, the database's unique constraint makes the losing one behave as a replay.
- **One open application per applicant.** A second application for the same National ID and CR gets `409` until the first is decided.
- **At-least-once delivery, idempotent consumers.** A check that's already final is skipped. The decision is a compare-and-set transition, so duplicate or concurrent `check.completed` events can't produce two decisions.
- **Retries without plugins.** Delay queues with a TTL dead-letter each message back to its own queue, giving exponential backoff. Only temporary failures are retried; clear answers and broken responses are recorded as they are.
- **Always reaches a decision.** Running out of retries is recorded as `unavailable`, not thrown. If the last attempt fails for a non-provider reason (a bug or a database outage), the check is still marked unavailable.
- **Dead-lettering.** Unparseable messages, and messages that fail every attempt, go to `financing.dead-letter` instead of looping forever.
- **Broker resilience.** Queues are durable quorum queues, messages are persistent, and publishes wait for broker confirms. Both processes reconnect on their own, re-declare the topology and re-attach their consumers. The API keeps accepting applications while the broker is down.

## Security

- **Encryption at rest.** National ID, CR number and provider replies are encrypted with AES-256-GCM.
- **Blind indexes.** Keyed HMAC-SHA256 hashes support the "open application" lookup and the idempotency comparison without decrypting. A plain hash would be guessable, because a 10-digit ID has few possible values.
- **Masking.** API responses and logs only ever show masked IDs, such as `1*******70`. Events and the audit log carry none.
- **Tenant isolation.** Every read is filtered by the client ID in the token. Another client's application returns `404`.
- **Tokens.** JWTs are signed with HS256 only, with a pinned issuer and a 15-minute lifetime. The demo secret is compared in constant time. Setting `ENABLE_DEMO_AUTH=false` disables the demo token endpoint for production.
- **Input and transport.** Validation rejects unknown fields. Helmet sets the security headers. Rate limits are 120 requests a minute overall and 10 a minute on `/auth/token`.

## Testing

### End-to-end (Jest)

The suite starts the real API and worker inside Jest. It runs against its own PostgreSQL and RabbitMQ from `docker-compose.e2e.yml` (ports 5433 and 5673), so it never touches your dev data and can run while the dev stack is up.

```bash
npm run e2e:up      # start the e2e infrastructure
npm run test:e2e    # 39 tests, about 15 seconds
npm run e2e:down    # remove it
```

Timeouts and backoff are shortened in `test/e2e-env.ts`, so even the "provider down" scenarios settle in about a second.

| File | Covers |
|---|---|
| `test/api.e2e-spec.ts` | Health and OpenAPI, auth, validation, idempotency, the open-application conflict, tenant isolation, the audit trail |
| `test/pipeline.e2e-spec.ts` | All 18 provider scenarios. Also: IDs stored only encrypted, every outbox event published, the relay recovering an unpublished event, duplicate events ignored, unparseable messages dead-lettered. |

Run a single file or test:

```bash
npm run test:e2e -- test/api.e2e-spec.ts
npm run test:e2e -- -t "SIMAH down"
```

### Postman

Import both files in `postman/` and select the **Financing API - Local** environment. The collection fetches and renews the token itself. It contains:

- **Applications:** the happy path, idempotent replay and conflicts.
- **Error handling:** every 4xx case.
- **Verification scenarios:** 18 scenarios. Each **Result** request waits for the decision and checks it.
- **Mock gateways:** direct calls to the mock providers.

The full collection makes 201 assertions in about 3 minutes. To run it headless against a running stack:

```bash
npm run test:postman -- --env-var baseUrl=http://localhost:3001
```

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. It checks formatting with `npm run format:check` and fails if any file under `src/` or `test/` isn't Prettier-formatted. Run `npm run format` locally to fix it.

## Configuration

All variables are validated at startup; see `src/shared/config/env.validation.ts`. Defaults are in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | API port |
| `DATABASE_URL` | `postgresql://app:app@localhost:5432/app` | PostgreSQL |
| `RABBITMQ_URL` | `amqp://app:app@localhost:5672` | RabbitMQ |
| `RABBITMQ_PUBLISH_TIMEOUT_MS` | `2000` | How long a publish waits before the outbox relay takes over |
| `JWT_SECRET`, `JWT_TTL_SECONDS` | –, `900` | Token signing key (at least 32 characters) and lifetime |
| `ENABLE_DEMO_AUTH`, `DEMO_CLIENT_ID`, `DEMO_CLIENT_SECRET` | `true`, `demo-client`, `demo-client-secret` | Demo token endpoint |
| `ENCRYPTION_KEY`, `BLIND_INDEX_KEY` | – | 32 bytes, base64 (`openssl rand -base64 32`) |
| `GATEWAY_BASE_URL` | `http://localhost:3001/mock` | Where the worker sends provider calls |
| `GATEWAY_TIMEOUT_MS`, `WATHIQ_TIMEOUT_MS` | `5000`, `3000` | Per-call timeouts |
| `RETRY_ATTEMPTS`, `RETRY_BACKOFF_MS` | `5`, `2000` | Attempts per message, and the first delay (each later delay doubles) |
| `OUTBOX_RELAY_INTERVAL_MS`, `OUTBOX_RELAY_AFTER_MS` | `5000`, `5000` | How often the relay runs, and how old an unpublished event must be before it republishes it |
| `MOCK_SLOW_RESPONSE_MS`, `MOCK_CHAOS_RATE` | `6000`, `0` | Mock delay for the slow scenarios; probability (0 to 1) of random failures on happy paths |

## Project layout

```
src/
├── apps/
│   ├── api/         main.ts · setup-app.ts · app.module.ts · health controller · request logging
│   └── worker/      main.ts · worker.module.ts · outbox relay
├── modules/
│   ├── api/         auth · applications · mock-gateways
│   └── worker/      verification (consumers, gateways, retries) · decision (consumer, rules)
└── shared/          core module · applications data module · messaging (RabbitMQ, outbox, events) · config · crypto · prisma
test/                e2e suite and harness
postman/             collection and environment
prisma/              schema and migrations
```

Each process has its own app folder (entry point, root module, non-module files) and its own feature modules. API modules never import worker modules, or the reverse; both depend only on `shared/`.

| Script | Does |
|---|---|
| `npm run build` | Compiles both apps to `dist/apps/api/main.js` and `dist/apps/worker/main.js` |
| `npm run start:dev`, `npm run start:worker:dev` | Run the API and the worker in watch mode |
| `npm start`, `npm run start:worker` | Run the compiled apps |
| `npm run lint` | ESLint |
| `npm run format`, `npm run format:check` | Format with Prettier, or only check formatting (what CI runs) |

## Trade-offs and next steps

- **Fixed backoff, no jitter.** Each delay queue has a fixed TTL. Jitter would need more delay queues or the delayed-message plugin.
- **The outbox relay doesn't claim rows.** With several workers, an event can be published twice. That's acceptable because every consumer is idempotent. `SELECT … FOR UPDATE SKIP LOCKED` would remove the duplicates.
- **Mocks live in the API process,** so the worker reaches them over real HTTP. Integrating the real providers means replacing the three gateway adapters in `modules/worker/verification/gateways/`.
- **The demo token endpoint stands in for a real identity provider.** Production would use the platform's IdP for clients and Nafath for the applicant.
- **Not built yet:** unit tests for the decision rules and gateway parsing, lint, build and e2e jobs in CI, a readiness probe that checks the database and broker, metrics and tracing, and a tool to replay dead-lettered messages.
