# 📦 Dispatch Queue Engine — Webhook Dispatcher

> **Stack: Express.js · BullMQ · Redis · PostgreSQL · Docker · Jest**

---

## 🔥 The Real Problem

Most teams build their webhook integrations like this:

```
Client fires HTTP request → Your server → Immediately calls third-party API
```

This breaks in production **every single day**:

| Actual Problem | What Happens in Reality |
|---|---|
| **Duplicate Events** | Stripe, GitHub, and payment gateways retry failed webhooks. Your server processes the same order twice. Money is charged twice. Inventory is decremented twice. |
| **Downstream is Down** | Your third-party API (Slack, email service, CRM) goes down for 3 minutes. You return a 500. The upstream never resends. The event is **permanently lost**. |
| **No Retry Logic** | You wrote a `try/catch` that logs an error and moves on. 40% of your webhook events silently disappear under load. |
| **Crash Propagation** | One malformed payload crashes your entire Node.js process. All in-flight requests die. |
| **No Audit Trail** | Something went wrong. Which events failed? When? With what error? Nobody knows. |

---

## ✅ How This System Solves It

**Dispatch Queue Engine** is a self-hosted, drop-in webhook relay you deploy once and point your clients at.

```
Before:  Client → Your Server → Third-party API    (fragile, synchronous, no retry)

After:   Client → Dispatch Engine → Queue → Worker → Third-party API
                       ↓                      ↓
                Duplicate blocked        Auto-retry with backoff
                in < 1ms (Redis)         → DLQ if all 5 fail
```

Anyone can host this on their server, point it at their own Redis + PostgreSQL, and **never write webhook retry logic again**. The engine handles:

- **Deduplication** — same event key never processes twice, guaranteed by atomic Redis locks
- **Retries with backoff** — automatic, configurable, no client code needed
- **HMAC verification** — downstream services can cryptographically verify every payload
- **Dead-Letter Queue** — every failure is captured, stored, and replayable via an admin API
- **Zero custom code** — clients just POST to `/webhooks/ingest` with a payload and a target URL

---

## 🌐 How Anyone Can Use This (Host Once, Use Forever)

```
Step 1: Clone this repo
Step 2: cp .env.example .env  →  fill in your Redis + PostgreSQL URLs + secrets
Step 3: docker compose up -d
Step 4: Done — your dispatcher is live on port 3000
```

**Who calls it?** → **Your own backend server.** Not a browser, not an end-user.

When your user hits your API and an event occurs (payment confirmed, order placed, user signed up), your server makes one HTTP call to the dispatcher instead of calling the third-party API directly:

```javascript
// Inside YOUR backend — instead of calling Slack/CRM/email directly:
await axios.post('https://your-dispatcher.com/webhooks/ingest', {
  target_url: 'https://slack.com/webhook',
  payload: { event: 'payment.success', amount: 9900 }
}, {
  headers: { 'Idempotency-Key': order.id }  // use your event's natural unique ID
});
// ↑ Your server responds in < 50ms. Dispatcher handles everything else.
```

The engine queues it, retries it on failure, signs it with HMAC, and drops it into DLQ if unreachable — **without you writing a single line of retry logic**.

---

## 📋 Functional Requirements

### FR-1: Idempotent Webhook Ingestion

**Endpoint:** `POST /webhooks/ingest`

**Headers:**
```
Idempotency-Key: <uuid-v4>       [Required]
Content-Type: application/json
```

**Behavior:**
- Validate `Idempotency-Key` header — reject `400` if absent or not UUID v4 format.
- Atomic Redis `SETNX idempotency:<key>` with **24-hour TTL**.
  - Key already exists → `409 Conflict` (duplicate blocked instantly, < 1ms).
  - Key is new → enqueue job → `202 Accepted` with `{ "job_id": "...", "status": "queued" }`.
- Validate body: `target_url` (valid URL) + `payload` (object) are required.

**Edge Cases:**
- Empty body → `400`
- `Idempotency-Key` > 128 chars → `400`
- Redis down → `503` (never silently ignore)

---

### FR-2: Queue Worker with Retry & Backoff

**Worker:** Separate Node.js process — **never** runs in the same process as the API server.

**Retry Schedule:**
```
Attempt 1:  immediate
Attempt 2:  ~2s   (2^1 * 1000ms + random 0–500ms jitter)
Attempt 3:  ~4s   (2^2 * 1000ms + jitter)
Attempt 4:  ~8s   (2^3 * 1000ms + jitter)
Attempt 5:  ~16s  (2^4 * 1000ms + jitter)
```

**Jitter prevents thundering herd** — if 100 jobs fail at once, they don't all hammer the target at the same second.

```javascript
const jitter = Math.floor(Math.random() * 500);
const delay = Math.pow(2, attemptNumber) * 1000 + jitter;
```

**Per-attempt behavior:**
- 10-second hard HTTP timeout.
- Structured JSON log: `{ job_id, attempt, target_url, status_code, latency_ms, error }`.
- Worker crash → BullMQ re-delivers the locked job to the next available worker.

---

### FR-3: HMAC-SHA256 Payload Signing

Every outgoing HTTP request carries a signature header so downstream services can verify authenticity.

```javascript
const crypto = require('crypto');
const signature = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(JSON.stringify(payload))
  .digest('hex');
// Header sent: X-Dispatch-Signature: sha256=<hex>
```

- Secret loaded from env only — never hardcoded.
- Downstream verifies by recomputing HMAC with the shared secret and comparing.

---

### FR-4: Dead-Letter Queue (DLQ)

**Trigger:** Job fails all 5 retry attempts.

**PostgreSQL Schema:**
```sql
CREATE TABLE dead_letter_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          VARCHAR(255) NOT NULL UNIQUE,
  queue_name      VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL,
  target_url      TEXT NOT NULL,
  error_message   TEXT NOT NULL,
  error_stack     TEXT,
  attempt_count   INT NOT NULL DEFAULT 5,
  idempotency_key VARCHAR(128),
  first_attempt   TIMESTAMPTZ NOT NULL,
  failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replayed_at     TIMESTAMPTZ,
  replayed_by     VARCHAR(255)
);

CREATE INDEX idx_dlq_failed_at ON dead_letter_queue(failed_at DESC);
CREATE INDEX idx_dlq_job_id    ON dead_letter_queue(job_id);
```

- DLQ write failure logs as CRITICAL but never crashes the worker.
- Full `error.stack` preserved for debugging.

---

### FR-5: Admin Retry Endpoint

**Endpoint:** `POST /admin/retry-failed`

**Auth:** `Authorization: Bearer <ADMIN_TOKEN>` — `401` if missing.

```json
// Request body
{ "job_ids": ["uuid1", "uuid2"], "limit": 50 }
```

- `job_ids` → replay those specific jobs.
- `limit` only → replay oldest N DLQ entries.
- Already-replayed jobs → skipped, reported in response.
- Re-enqueues with a new job ID, same original payload.

---

## 🔧 Non-Functional Requirements

### Performance
- Ingest endpoint: **< 50ms p99** at 200 RPS (Redis lock + queue write).
- Worker: **> 100 dispatches/minute** per replica.

### Reliability
- `removeOnComplete: false` — no job is silently dropped from Redis.
- In-flight jobs survive worker crashes via BullMQ distributed locks.

### Observability
- Structured JSON logging (morgan + custom middleware).
- Every log includes `{ timestamp, level, job_id, service, message }`.
- `GET /health` → Redis + PostgreSQL connectivity check.

### Security
- All secrets from `.env` — zero hardcoding.
- Admin endpoints: bearer token guard.
- Body size limit: **1MB** (protects against payload bombing).
- Idempotency keys: UUID v4 regex validation before any Redis call.

### Containerization
- `docker-compose.yml`: `api`, `worker`, `redis`, `postgres` — one command to run everything.
- Named volumes: data survives container restarts.
- `.env.example`: every required variable documented.

---

## 🧪 Testing Requirements

### Unit Tests

| File | What It Validates |
|---|---|
| `idempotency.service.test.js` | SETNX blocks duplicate within 24h |
| `signer.service.test.js` | HMAC deterministic; tampered payload fails |
| `retry.policy.test.js` | Delay in expected exponential range |
| `dlq.service.test.js` | Failed job written to PostgreSQL |

### Integration Tests (Supertest)

| File | What It Validates |
|---|---|
| `ingest.test.js` | `202` new key, `409` duplicate |
| `dispatch.test.js` | Outgoing request has `X-Dispatch-Signature` |
| `dlq.test.js` | Timeout simulation → DLQ after 5 retries |
| `admin.test.js` | `401` no token, `200` valid token |

### Interview Proof Test

```javascript
it('routes poison-pill jobs to DLQ without crashing the worker', async () => {
  nock(TARGET_URL).post('/').times(5).replyWithError('ECONNRESET');

  const res = await request(app)
    .post('/webhooks/ingest')
    .set('Idempotency-Key', uuidv4())
    .send({ target_url: TARGET_URL, payload: { event: 'test' } });

  expect(res.status).toBe(202);
  await sleep(30_000); // wait for full backoff

  const dlqEntry = await db.query('SELECT * FROM dead_letter_queue WHERE job_id = $1', [res.body.job_id]);
  expect(dlqEntry.rows[0].attempt_count).toBe(5);
  expect(dlqEntry.rows[0].error_message).toContain('ECONNRESET');

  // Worker still alive — other jobs still process
  const health = await request(app).get('/health');
  expect(health.body.status).toBe('ok');
});
```

---

## 📁 Project Structure

```
dispatch-queue-engine/
└── backend/
    ├── src/
    │   ├── app.js                       # Express app factory
    │   ├── server.js                    # API server entrypoint
    │   ├── worker.js                    # BullMQ worker entrypoint (separate process)
    │   │
    │   ├── routes/
    │   │   ├── webhooks.routes.js       # POST /webhooks/ingest
    │   │   ├── admin.routes.js          # POST /admin/retry-failed
    │   │   └── health.routes.js         # GET /health
    │   │
    │   ├── services/
    │   │   ├── idempotency.service.js   # Redis SETNX logic
    │   │   ├── queue.service.js         # BullMQ enqueue
    │   │   ├── signer.service.js        # HMAC-SHA256 signing
    │   │   └── dlq.service.js           # DLQ write + replay
    │   │
    │   ├── workers/
    │   │   ├── dispatch.worker.js       # BullMQ processor
    │   │   └── retry.policy.js          # Backoff + jitter
    │   │
    │   ├── middleware/
    │   │   ├── auth.middleware.js        # Bearer token guard
    │   │   ├── validate.middleware.js    # Body validation
    │   │   └── logger.middleware.js      # Structured JSON logging
    │   │
    │   ├── db/
    │   │   ├── postgres.js              # pg pool singleton
    │   │   └── redis.js                 # ioredis singleton
    │   │
    │   └── config/
    │       └── env.js                   # Validated env config
    │
    ├── test/
    │   ├── unit/
    │   └── integration/
    │
    ├── docker-compose.yml
    ├── Dockerfile.api
    ├── Dockerfile.worker
    ├── .env.example
    └── package.json
```

---

## 🔑 Environment Variables

```env
# Application
NODE_ENV=development
PORT=3000

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# PostgreSQL
DATABASE_URL=postgresql://postgres:password@localhost:5432/dispatch_engine

# Security
WEBHOOK_SECRET=your-minimum-32-char-secret-here
ADMIN_TOKEN=your-secure-admin-token-here

# BullMQ
QUEUE_NAME=webhook-dispatch
MAX_RETRIES=5
JOB_TIMEOUT_MS=10000

# Idempotency
IDEMPOTENCY_TTL_SECONDS=86400
```

---

## 🚀 Implementation Phases

| Phase | Scope | Estimate |
|---|---|---|
| Phase 1 | Express scaffold + Docker Compose | 1 day |
| Phase 2 | Idempotency service + Redis | 1 day |
| Phase 3 | BullMQ queue + Worker + Retry | 2 days |
| Phase 4 | HMAC signing + Dispatch HTTP client | 1 day |
| Phase 5 | DLQ PostgreSQL + Admin endpoint | 1–2 days |
| Phase 6 | Jest unit + Integration suite | 2 days |
| Phase 7 | Health endpoint + README + Polish | 1 day |
| **Total** | | **~9–10 days** |

---

## 📊 Key Architectural Decisions

| Decision | Why |
|---|---|
| BullMQ over raw Redis queues | Built-in job state machine, retry hooks, delayed jobs, distributed worker locking |
| Separate worker process | Fault isolation — worker OOM/crash does not kill the API server |
| PostgreSQL DLQ over BullMQ built-in DLQ | Persistent, queryable, survives Redis flush, audit-friendly |
| Randomized jitter on backoff | Prevents thundering herd — 100 simultaneous failures don't retry at the same instant |
| Atomic SETNX for idempotency | Prevents race condition where two parallel requests with the same key both pass |
| Express over NestJS | Lightweight, minimal overhead, full visibility — no magic behind decorators |

---

*This document is the single source of truth. Every implementation decision must trace back to a requirement here.*
