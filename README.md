# Financing API

An API-only prototype of a small-business financing application pipeline. An applicant submits a National ID, a Commercial Registration (CR) number and a requested amount. The application then goes through three verifications, each against a mocked external Saudi gateway:

| Check | Gateway | Purpose |
|---|---|---|
| Identity | Nafath / Yakeen | Verify the National ID |
| Commercial registration | Wathiq | Is the CR active or expired? |
| Credit | SIMAH | Credit score and active defaults |

The result is one of three decisions: `approved_for_risk_assessment`, `rejected` or `requires_manual_compliance_review`.

The mock gateways deliberately misbehave: 503s, timeouts, unverified statuses, HTML instead of JSON. Specific digits in the submitted IDs choose the behaviour, so every failure path is reproducible. Most of the work is in how the system survives those failures.

**Stack:** NestJS 11 · TypeScript · PostgreSQL 16 (Prisma) · RabbitMQ 4 · Jest + Supertest · Docker Compose · Swagger + Postman

## Contents

- [Setup](#setup)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Resilience](#resilience)
- [Security](#security)
- [Future scope](#future-scope)
- [AI usage](#ai-usage)
- [Configuration](#configuration)

## Setup

Requires Docker. For local development and the tests you also need Node.js 22+.

### Run everything in Docker

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3001 |
| Swagger UI | http://localhost:3001/docs (OpenAPI JSON at `/docs/openapi.json`) |
| RabbitMQ management | http://localhost:15672 (`app` / `app`) |

The API container applies the database migrations before it starts.

### Run locally (watch mode)

```bash
cp .env.example .env
npm install
docker compose up -d postgres rabbitmq
npx prisma migrate deploy
npm run start:dev          # terminal 1: API
npm run start:worker:dev   # terminal 2: worker
```

> `GATEWAY_BASE_URL` must point at the API's own port (`http://localhost:<PORT>/mock`), because the worker calls the mock gateways through the API.
>
> If another RabbitMQ already listens on 5672, the worker logs `Cannot connect to RabbitMQ … ACCESS_REFUSED` and events wait in the outbox. Stop the other broker, or map this one to a free port and change `RABBITMQ_URL` to match.

### Test the endpoints

**Postman.** Import both files from `postman/` and select the **Financing API - Local** environment. The collection fetches and renews the bearer token itself. It has these folders:

| Folder | Covers |
|---|---|
| Applications | Submit, idempotent replay, conflicting replay, status, audit trail |
| Error handling | Every 4xx case |
| Verification scenarios | 18 scenarios. **Submit** creates the application; **Result** waits for the decision and checks it. |
| Mock gateways | Direct calls to the mocks |

A full run makes 201 assertions. To run it headless against a running stack:

```bash
npm run test:postman -- --env-var baseUrl=http://localhost:3001
```

**curl:**

```bash
TOKEN=$(curl -s -X POST localhost:3001/auth/token -H 'Content-Type: application/json' \
  -d '{"clientId":"demo-client","clientSecret":"demo-client-secret"}' | jq -r .accessToken)

curl -s -X POST localhost:3001/applications \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"nationalId":"1012345600","crNumber":"7001234560","requestedAmount":250000}'

curl -s localhost:3001/applications/<id> -H "Authorization: Bearer $TOKEN"   # poll until "decided"
```

### Automated tests

```bash
npm test             # 51 unit tests: decision rules, circuit breaker, HTTP failure classification, gateway parsing

npm run e2e:up       # throwaway PostgreSQL + RabbitMQ (ports 5433 and 5673)
npm run test:e2e     # 40 end-to-end tests against the real API and worker, about 20 s
npm run e2e:down
```

The e2e suite starts the real API and worker inside Jest, against their own database and broker, so it never touches dev data. Timeouts and backoff are shortened in `test/e2e-env.ts`, so the "provider down" scenarios settle in about a second. The suite covers:

- all 18 gateway scenarios
- validation, auth, idempotency and tenant isolation
- encryption at rest
- outbox delivery and recovery
- duplicate events
- dead-lettering
- the circuit breaker opening and recovering

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request: Prettier check, lint, type check and build, unit tests, and e2e tests.

## Architecture

### Overview

The system runs as two processes built from one codebase:

- The **API** validates input, persists the application, publishes an event and answers status queries. It never calls a gateway.
- The **worker** consumes events: it runs the checks against the gateways and makes the decision.

The two processes never call each other. They share PostgreSQL and communicate only through events on RabbitMQ.

```mermaid
flowchart LR
  C[Client] -->|POST /applications| API
  API -->|application + outbox row<br/>one transaction| DB[(PostgreSQL)]
  API -->|application.submitted| X{{financing.events<br/>topic exchange}}
  X --> QI[verification.identity]
  X --> QC[verification.commercial_registration]
  X --> QS[verification.credit]
  QI & QC & QS --> W[Worker: check consumers]
  W -->|HTTP via circuit breaker| M[Nafath / Wathiq / SIMAH mocks]
  W -->|check.completed| X
  X --> QD[decision]
  QD --> D[Worker: decision consumer]
  D -->|application.decided| X
```

### Life of an application

1. `POST /applications` validates the body, enforces idempotency, and in one transaction stores:
   - the application, with the IDs encrypted
   - three `pending` checks
   - an audit event
   - an `application.submitted` outbox row

   It returns `202 Accepted` with status `submitted`.
2. The event is published right after the commit. If RabbitMQ is unavailable, the worker's outbox relay publishes it later.
3. Each check type has its own queue, so the three checks run in parallel and a slow gateway never holds up the others. The first check to start moves the application to `verifying`.
4. Each gateway answer is recorded as `verified`, `failed` or `ambiguous`, together with a `check.completed` event in the same transaction.
   - Transient failures are retried with exponential backoff.
   - If retries run out, the check becomes `unavailable`.
5. The decision consumer receives every `check.completed`. Once all three checks are final, it applies the rules, moves the application to `decided` and emits `application.decided`.
6. The client polls `GET /applications/{id}`, and can read `GET /applications/{id}/events` for the audit trail.

### Domain model

| Entity | Role |
|---|---|
| `Application` | The aggregate. Status moves `submitted → verifying → decided` through compare-and-set transitions only. Holds the encrypted identifiers with their blind indexes, the decision and its reasons. |
| `VerificationCheck` | One per check type. Stores the status (`pending`, `retrying`, `verified`, `failed`, `ambiguous`, `unavailable`), attempts, `reasonCode`, `lastError`, latency, and the encrypted gateway payload. |
| `AuditEvent` | Append-only trail of every step, with no raw identifiers. |
| `OutboxEvent` | Events waiting to be published, written in the same transaction as the change they announce. |

The status vocabulary separates *what the gateway said* from *whether we could ask it*:

- `failed` is a definitive negative and rejects the application.
- `ambiguous` (an unreadable or inconclusive answer) and `unavailable` (the gateway couldn't be reached) both go to manual review.

### Service classes and gateway integrations

```
VerificationConsumer          one RabbitMQ consumer per check queue; maps delivery attempt -> retry or give up
  └─ VerificationService      runs one attempt of one check; records the outcome + check.completed (outbox)
       └─ VerificationGateway (port)    verify(subject): Promise<GatewayOutcome>
            ├─ IdentityGateway       Nafath / Yakeen
            ├─ CrRegistryGateway     Wathiq
            └─ CreditBureauGateway   SIMAH
                 └─ HttpGatewayClient    one HTTP call: timeout, circuit breaker, transient-error classification
DecisionConsumer              fan-in on check.completed; decides once all three checks are final
  └─ DecisionService          pure eligibility rules (no I/O), thresholds in decision.rules.ts
```

- **Adapters only translate.** Each gateway adapter turns a provider response into a `GatewayOutcome`: `verified`, `failed` with a reason, or `ambiguous` with a reason. Transport problems are never returned; `HttpGatewayClient` throws them as `TransientGatewayError`.
- **Business rules live elsewhere.** Judging a credit score is the decision engine's job, not the adapter's.
- **Swapping in real gateways** means replacing the three adapters (or pointing `GATEWAY_BASE_URL` at them). Nothing else changes.

### Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Asynchronous decision (202 + polling)** | Gateway latency and retries can take tens of seconds; holding an HTTP request open that long is fragile and wastes connections. | Clients poll. Publishing `application.decided` already allows a webhook later. |
| **Event-driven over RabbitMQ** | Each step reacts to an event, and new consumers (notifications, risk engine) can subscribe without touching existing code. Durable quorum queues and publisher confirms keep messages safe. | More moving parts than an in-process job queue. |
| **Transactional outbox** | Avoids the dual-write problem: an event is published if and only if its database change committed. | Delivery is at least once, so every consumer must be idempotent (they are). |
| **Fan-out per check, fan-in via the database** | Checks are independent and run in parallel. The decision consumer reads the stored check states instead of carrying them in messages. | One extra read per `check.completed`. |
| **Retries via delay queues** | Retries survive worker restarts and need no broker plugin. Each failed message waits in a TTL queue and is routed back to its own queue only. | Fixed delays per level (no jitter). |
| **Circuit breaker per gateway, per process** | Stops hammering a gateway that's already down and fails fast instead. | State isn't shared between workers, so each worker trips its own breaker. |
| **Separate API and worker apps** | Each can be deployed and scaled on its own. The API stays fast because it never waits on a gateway. API modules and worker modules never import each other; both depend only on `shared/`. | Two deployables. |
| **NestJS instead of Laravel** | The brief allowed any backend. NestJS's module system maps directly onto the boundaries above, TypeScript gives end-to-end typing, and one language covers the full stack. | |

### Project layout

```
src/
├── apps/
│   ├── api/         main.ts · setup-app.ts · app.module.ts · health controller · request logging
│   └── worker/      main.ts · worker.module.ts · outbox relay
├── modules/
│   ├── api/         auth · applications · mock-gateways
│   └── worker/      verification (consumer, service, gateways, circuit breaker) · decision (consumer, rules)
└── shared/          core module · applications data module · messaging (RabbitMQ, outbox, events) · config · crypto · prisma
test/                e2e suite, harness and environment
postman/             collection and environment
prisma/              schema and migrations
```

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | – | Liveness probe |
| `POST` | `/auth/token` | – | Demo client-credentials token (JWT, 15 min). Limited to 10 per minute. |
| `POST` | `/applications` | Bearer | Submit an application. Requires an `Idempotency-Key` header. Returns `202`. |
| `GET` | `/applications/{id}` | Bearer | Status, decision, reasons and per-check results |
| `GET` | `/applications/{id}/events` | Bearer | Audit trail |
| `GET` | `/mock/scenarios` | – | Which digit triggers which mock behaviour |
| `POST` | `/mock/nafath/verify` · `/mock/wathiq/cr-status` · `/mock/simah/credit-report` | – | The mock gateways |

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
| `409` | The key was reused with a different body, or this National ID and CR already have an application in progress |
| `429` | Rate limit exceeded |

### Mock gateway scenarios

| Gateway | Selected by | Digit → behaviour |
|---|---|---|
| Nafath / Yakeen | Last digit of `nationalId` | `1` not verified · `2` 503 twice, then verified · `3` pending confirmation (ambiguous) · `4` always 503 · other digits verified |
| Wathiq | Last digit of `crNumber` | `1` expired · `2` first call exceeds the 3 s timeout, then active · `3` every call times out · `4` 404 not found · `5` HTML maintenance page · other digits active |
| SIMAH | Second-to-last digit of `nationalId` | `1` score 480 · `2` 503 twice, then 720 · `3` always 503 · `4` score 600 · `5` 2 active defaults · `6` no credit file · other digits score 720 |

`MOCK_CHAOS_RATE` (0 to 1) also injects random 503s and slow empty responses into the happy paths.

### Eligibility rules

The rules are in `src/modules/worker/decision/`, as a pure function with its thresholds kept as data.

| Decision | When |
|---|---|
| `rejected` | Any definitive negative: identity not verified, CR expired, inactive or not found, a credit score below 550, or any active default. A rejection wins over everything else. |
| `requires_manual_compliance_review` | Nothing to reject, but something is uncertain: a check is ambiguous or unavailable, the credit score is 550 to 649, or the amount is above 1,000,000 SAR |
| `approved_for_risk_assessment` | All three checks are clean. The application moves on to the risk engine; this is not a loan approval. |

A gateway being unavailable never rejects an applicant on its own. It sends the application to a human.

## Resilience

### How each failure is handled

| Failure | Detected by | Handling | Outcome |
|---|---|---|---|
| SIMAH returns 503 | `HttpGatewayClient` (5xx, 429 and 408 are transient) | Check marked `retrying`, message re-queued with backoff (2, 4, 8, 16 s) | Recovers on a later attempt, or `unavailable` after 5 attempts → manual review |
| Wathiq is slow or hangs | Hard per-call timeout (`AbortSignal.timeout`, 3 s for Wathiq) | Treated as transient: retry with backoff | Same as above |
| A gateway is fully down | Circuit breaker: 5 consecutive transient failures open it for 10 s | Calls fail fast with `CIRCUIT_OPEN` without reaching the gateway. After the cooldown, a single trial call decides whether to close or reopen. | Less load on a struggling gateway; affected checks retry and recover, or go to manual review |
| Nafath says "not verified", Wathiq says "expired" or 404 | Adapter mapping | Recorded as a definitive `failed`; never retried | `rejected` |
| Ambiguous answer (pending confirmation, HTML instead of JSON, no credit file, out-of-range score) | Adapter validation | Recorded as `ambiguous` with a reason code; never guessed | Manual review |
| RabbitMQ down when submitting | Publish timeout (`RABBITMQ_PUBLISH_TIMEOUT_MS`) | The event stays in the outbox; the relay republishes it every 5 s | `202` is still returned and nothing is lost |
| Crash between commit and publish | Unpublished outbox row | Outbox relay | The event is delivered late, never lost |
| Worker crashes mid-check | Unacknowledged message | RabbitMQ redelivers; a check that's already final is skipped | Processed exactly once in effect |
| Bug or database outage on the last attempt | Exception on the final delivery | The check is marked `unavailable` (`PROCESSING_ERROR`) so the application still gets decided | Manual review |
| Unparseable message | JSON parse fails | Dead-lettered immediately to `financing.dead-letter` | No infinite loop; kept for inspection |
| Duplicate `check.completed` | — | The decision is a compare-and-set transition | Exactly one decision |
| Client retries a submit | `Idempotency-Key` | Same key and body: the original is replayed. Different body: `409`. Concurrent duplicates are settled by a unique constraint. | No duplicate applications |
| Second application while one is open | Blind-index lookup | `409` | One open application per National ID and CR |

### Mechanisms

- **Retries.** Delay queues `financing.retry.<delay>ms` hold failed messages for 2, 4, 8 and then 16 seconds. When a message's TTL expires, it's routed back to the queue it came from. Retries go through the broker, so they survive restarts. Only transient errors are retried.
- **Circuit breaker.** There is one breaker per gateway, in `CircuitBreakerRegistry`, and it counts only transport failures. A clear negative answer such as "CR not found" means the gateway is healthy. State changes are logged.
- **Queued jobs.** The three checks are independent consumers with bounded concurrency (prefetch). The queues are durable quorum queues, messages are persistent, and publishes wait for broker confirms. Both processes reconnect on their own and re-declare the topology.
- **No silent data loss.** The application and its outbox event are written in one transaction. Every state change is audited. Messages that fail for good are dead-lettered, not dropped.

## Security

### Data in transit

- The API is meant to run behind TLS, terminated at the ingress or load balancer. Helmet sends HSTS and the other security headers.
- In production, the connections to PostgreSQL and RabbitMQ use TLS. `DATABASE_URL` takes `sslmode=require`, and `RABBITMQ_URL` accepts `amqps://`; the config validation allows both.
- Gateway calls would go over HTTPS, with mutual TLS where the provider supports it.
- Events and queue messages carry only the application ID. Consumers read and decrypt what they need from the database, so no personal or financial data passes through the broker.

### Data at rest

- **Encryption.** National ID, CR number and the gateway result payloads (including the credit report) are encrypted with AES-256-GCM: authenticated encryption with a random IV per value. Plain values never reach the database.
- **Blind indexes.** Keyed HMAC-SHA256 hashes support the lookups that need equality, such as "is there an open application for this National ID and CR?" and the idempotency payload comparison, without decrypting anything. A plain hash would be guessable, because a 10-digit ID has few possible values.
- **Key management.** Encryption keys come from the environment and are never committed. Production would load them from a KMS or secrets manager.

### Exposure and access

- **Masking.** API responses show only masked IDs, such as `1*******70`.
- **Logs.** The access log records method, route, status and duration only: never bodies, query strings or headers. The audit trail carries no raw identifiers.
- **Authentication.** Every application endpoint needs a JWT. Tokens are signed with HS256 only, with a pinned issuer and a 15-minute lifetime. The demo secret is compared in constant time. `ENABLE_DEMO_AUTH=false` turns the demo token endpoint off for production.
- **Tenant isolation.** Every query is filtered by the client ID in the token. Another client's application returns `404`, not `403`, so IDs can't be probed.
- **Input and abuse.** Strict validation rejects unknown fields. Rate limits are 120 requests a minute overall and 10 a minute on `/auth/token`. CORS is not enabled, because this is a server-to-server API.
- **Containers.** The Docker image is multi-stage and runs as a non-root user.

### Compliance

The design leans towards SAMA's cyber security expectations and the Saudi Personal Data Protection Law:

- data minimisation in events and logs;
- encryption of personal and financial data;
- an immutable audit trail of each decision and the evidence behind it;
- no applicant data leaving the database except masked.

## Future scope

- **Shared circuit state** (for example in Redis) so all workers trip together, plus jitter on retry delays.
- **Outbox relay claiming rows** with `SELECT … FOR UPDATE SKIP LOCKED`, to avoid duplicate publishes when several workers run.
- **A webhook or server-sent events** for the decision, instead of polling.
- **Readiness and observability:** a readiness probe that checks the database and the broker, OpenTelemetry tracing across HTTP and RabbitMQ (with the application ID as the trace key), metrics on queue depth, breaker state and decision latency, and alerts on the dead-letter queue.
- **A replay tool for dead-lettered messages,** with an audit trail of who replayed what.
- **Key management:** envelope encryption through a KMS, key rotation with a key ID stored on each ciphertext, and field-level access policies.
- **Real integrations:** the real Nafath, Wathiq, Yakeen and SIMAH clients with mutual TLS, contract tests against their sandboxes, and per-provider timeout and retry budgets.
- **Rules as configuration:** eligibility rules versioned in the database, with the rule version recorded on each decision.
- **Auth:** OAuth2 client credentials from the platform's identity provider instead of the demo issuer, and scopes per endpoint.
- **Load testing** of the submit path and of queue throughput under gateway outages.

## AI usage

I used an AI coding agent (Claude Code) throughout, as a pair programmer under my direction.

**Where I used it**

- Scaffolding the NestJS modules, DTOs and Prisma schema.
- Building the mock gateway scenario layer.
- Migrating the queueing layer to RabbitMQ with a transactional outbox.
- Restructuring into separate `apps/`, `modules/` and `shared/` folders. A script rewrote the imports.
- Writing the unit and e2e tests and generating the Postman collection.
- Drafting this README.

**Decisions I made and steered it towards**

- Replacing the agent's initial Redis job queue with an event-driven RabbitMQ design.
- Separating the API and worker code so neither imports the other.
- Neutral naming.
- Reviewing the result against the brief line by line. That review found the circuit breaker missing, and it was added afterwards.

**Where it fell short**

- **Configuration drift.** After a port change, `GATEWAY_BASE_URL` still pointed at the old port, so the worker called a different service. Failing Postman scenarios exposed it. I fixed the configuration and documented the rule that both must match.
- **Silent connection failures.** The RabbitMQ client reports failed connection attempts as a separate event, and the first version didn't log it. A port clash with another local broker therefore showed up only as repeated "relay will retry: timeout" warnings. I traced it to a refused login and added explicit logging.
- **A broker healthcheck that broke the broker.** Running `rabbitmq-diagnostics` as root created a root-owned Erlang cookie before the server started, and the server then crashed. The healthcheck now runs as the `rabbitmq` user.
- **A flaky test.** One e2e assertion checked an asynchronously published outbox row too early. It was a test bug, not an application bug; the test now waits for the publish.
- **Dependency choice.** It initially reached for the newest major versions; one had been released that day. I pinned long-stable versions instead.
- **A destructive command.** It tried `prisma migrate reset` in the test setup, and Prisma refused because an AI agent was running it. The setup now uses the non-destructive `migrate deploy` against a throwaway database.

**How I verified its output**

- I read every architectural change as a diff before accepting it.
- 51 unit tests cover the pure logic.
- 40 e2e tests run against real PostgreSQL and RabbitMQ.
- The Postman collection makes 201 assertions, run headless with Newman.
- I ran manual failure drills: stopping the broker while submitting (the outbox relay delivered the event later), stopping the worker (the queue backlog drained on restart), and publishing a poison message (it went to the dead-letter queue).
- CI runs Prettier, lint, a type check, the build and both test suites on every push.

## Configuration

All variables are validated at startup (`src/shared/config/env.validation.ts`). Defaults are in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | API port |
| `DATABASE_URL` | `postgresql://app:app@localhost:5432/app` | PostgreSQL (`sslmode=require` in production) |
| `RABBITMQ_URL` | `amqp://app:app@localhost:5672` | RabbitMQ (`amqps://` in production) |
| `RABBITMQ_PUBLISH_TIMEOUT_MS` | `2000` | How long a publish waits before the outbox relay takes over |
| `JWT_SECRET`, `JWT_TTL_SECONDS` | –, `900` | Token signing key (at least 32 characters) and lifetime |
| `ENABLE_DEMO_AUTH`, `DEMO_CLIENT_ID`, `DEMO_CLIENT_SECRET` | `true`, `demo-client`, `demo-client-secret` | Demo token endpoint (disable in production) |
| `ENCRYPTION_KEY`, `BLIND_INDEX_KEY` | – | 32 bytes, base64 (`openssl rand -base64 32`) |
| `GATEWAY_BASE_URL` | `http://localhost:3001/mock` | Where the worker sends gateway calls |
| `GATEWAY_TIMEOUT_MS`, `WATHIQ_TIMEOUT_MS` | `5000`, `3000` | Per-call timeouts |
| `RETRY_ATTEMPTS`, `RETRY_BACKOFF_MS` | `5`, `2000` | Attempts per message, and the first delay (each later delay doubles) |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `CIRCUIT_BREAKER_COOLDOWN_MS` | `5`, `10000` | Consecutive transient failures that open a gateway's circuit, and how long it stays open |
| `OUTBOX_RELAY_INTERVAL_MS`, `OUTBOX_RELAY_AFTER_MS` | `5000`, `5000` | How often the relay runs, and how old an unpublished event must be before it republishes it |
| `MOCK_SLOW_RESPONSE_MS`, `MOCK_CHAOS_RATE` | `6000`, `0` | Mock delay for the slow scenarios; probability of random failures on happy paths |

| Script | Does |
|---|---|
| `npm run build` | Compiles both apps to `dist/apps/api/main.js` and `dist/apps/worker/main.js` |
| `npm run start:dev`, `npm run start:worker:dev` | Run the API and the worker in watch mode |
| `npm start`, `npm run start:worker` | Run the compiled apps |
| `npm test`, `npm run test:e2e`, `npm run test:postman` | Unit, e2e and Postman tests |
| `npm run e2e:up`, `npm run e2e:down` | Start or remove the e2e infrastructure |
| `npm run lint`, `npm run format`, `npm run format:check` | ESLint; format with Prettier, or check only (CI) |
