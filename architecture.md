# Architecture Document — Dispatch Queue Engine

> From Low-Level Implementation to High-Level System Design

---

## 1. High-Level Design (HLD)

### What This System Is

A **standalone, self-hosted webhook relay service**. Any team deploys it once and calls it from their own backend. When their API handles an event (payment confirmed, user signed up, order placed), instead of calling third-party services directly, **their server calls this dispatcher**. The engine guarantees delivery, deduplication, and auditability from there.

> **"Client" throughout this document always means the user's own backend server — not a browser or end-user.**

```
┌─────────────────────────────────────────────────────────────────┐
          │  │  Slack   │  │  CRM     │  │  Email Svc    │  │
          │  │  Webhook │  │  API     │  │  (SendGrid)   │  │
          │  └──────────┘  └──────────┘  └───────────────┘  │
          └─────────────────────────────────────────────────┘
```

### HLD: Component Responsibilities

| Component | Role | Technology |
|---|---|---|
| **API Server** | Accepts events, deduplicates, enqueues | Express.js |
| **Redis** | Job queue (BullMQ) + Idempotency key store | Redis 7+ |
| **Worker Process** | Consumes queue, retries, signs, dispatches | Node.js + BullMQ |
| **MongoDB** | Dead-Letter Queue storage, audit log | MongoDB 15+ |
| **Docker Compose** | Orchestrates all services | Docker |

---

## 2. Request Flow Diagram (End-to-End)

```
Your Backend Server
  │  (this is the caller — your own API server, triggered by an event in your system)
  │
  │ POST /webhooks/ingest
  │ Idempotency-Key: order_id-abc-123  ← use your event's natural unique ID
  │ Body: { target_url, payload }
  │
  ▼
┌─────────────────────────────────────────────┐
│  Express Middleware Stack                    │
│                                             │
│  1. body-parser (JSON, 1MB limit)           │
│  2. logger.middleware (structured JSON)     │
│  3. validate.middleware (body schema check) │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Idempotency Check (idempotency.service.js)  │
│                                             │
│  Redis: SET idempotency:abc-123 NX EX 86400 │
│                                             │
│  ┌─── Key exists? ──────────────────────┐   │
│  │   YES → return 409 Conflict (< 1ms) │   │
│  │   NO  → continue to enqueue         │   │
│  └──────────────────────────────────────┘   │
└──────────────────┬──────────────────────────┘
                   │ (only new keys reach here)
                   ▼
┌─────────────────────────────────────────────┐
│  Queue Service (queue.service.js)            │
│                                             │
│  BullMQ: queue.add('dispatch', {            │
│    target_url, payload, idempotency_key     │
│  }, { attempts: 5, backoff: 'custom' })     │
│                                             │
│  Returns: { job_id: "bull:job:42" }         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
             202 Accepted
         { job_id, status: "queued" }


─────── ASYNC (Worker Process) ─────────────────

Redis (BullMQ Queue)
  │
  │ Job dequeued
  ▼
┌─────────────────────────────────────────────┐
│  dispatch.worker.js                          │
│                                             │
│  1. Pull job from queue                     │
│  2. Call signer.service.js                  │
│     → HMAC-SHA256(payload, WEBHOOK_SECRET)  │
│     → Header: X-Dispatch-Signature: sha256= │
│  3. HTTP POST to target_url (10s timeout)   │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
      200 OK             Error (timeout/5xx)
        │                     │
        ▼                     ▼
   Job marked           retry.policy.js
   complete             exponential backoff
                        + jitter delay
                              │
                    ┌─────────┴─────────┐
                    │                   │
               Retry #N < 5        All 5 failed
                    │                   │
                    ▼                   ▼
              Re-enqueue          dlq.service.js
              (delayed)           MongoDB INSERT
                                  dead_letter_queue
                                       │
                                  Admin can replay via
                                  POST /admin/retry-failed
```

---

## 3. Low-Level Design (LLD)

### 3.1 Idempotency Service

**File:** `src/services/idempotency.service.js`

```
checkAndLock(key: string): Promise<boolean>
├── Validate key format (UUID v4 regex)
├── redis.set(`idempotency:${key}`, Date.now(), 'NX', 'EX', TTL)
│     NX = only set if Not eXists (atomic SETNX equivalent)
│     EX = expire in 86400 seconds
├── Returns true  → key was new, proceed
└── Returns false → key existed, return 409
```

**Why atomic?** Without `NX`, two concurrent requests can both read "key missing" and both enqueue. The `SET NX` command is a single atomic Redis operation — no race condition possible.

---

### 3.2 Retry Policy

**File:** `src/workers/retry.policy.js`

```
BullMQ job options:
{
  attempts: 5,
  backoff: {
    type: 'custom'
  }
}

backoffStrategy(attemptsMade: number): number
├── base = 2^attemptsMade * 1000          (exponential base)
├── jitter = Math.floor(Math.random() * 500)
└── return base + jitter                  (milliseconds)

Timeline:
  Attempt 1:  0ms      (immediate)
  Attempt 2:  ~2000ms  (2s + 0-500ms jitter)
  Attempt 3:  ~4000ms  (4s + jitter)
  Attempt 4:  ~8000ms  (8s + jitter)
  Attempt 5:  ~16000ms (16s + jitter)
  → DLQ
```

**Why jitter?** Thundering herd problem: if 200 jobs all fail at t=0 and all retry at exactly t+2000ms, you create a synchronized spike. Jitter spreads retries across a 500ms window, smoothing load.

---

### 3.3 HMAC Signer

**File:** `src/services/signer.service.js`

```
sign(payload: object): string
├── body = JSON.stringify(payload)        (canonical serialization)
├── hmac = crypto.createHmac('sha256', WEBHOOK_SECRET)
├── hmac.update(body)
└── return `sha256=${hmac.digest('hex')}`

Downstream Verification:
├── Receive X-Dispatch-Signature header
├── Recompute HMAC with shared secret
└── Compare with timingSafeEqual (prevents timing attacks)
```

```javascript
// Downstream verification example
const crypto = require('crypto');
function verify(payload, receivedSig, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  const sigBuf = Buffer.from(receivedSig.replace('sha256=', ''));
  const expBuf = Buffer.from(expected);
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
```

---

### 3.4 DLQ Service

**File:** `src/services/dlq.service.js`

```
writeToDLQ(job, error): Promise<void>
├── Extract: job_id, payload, target_url, idempotency_key
├── Capture: error.message, error.stack, attempt_count, first_attempt
└── pg.query: INSERT INTO dead_letter_queue (...) VALUES (...)
      ON CONFLICT (job_id) DO NOTHING   ← idempotent write

replayJobs({ job_ids?, limit? }): Promise<ReplayResult>
├── SELECT FROM dead_letter_queue
│     WHERE replayed_at IS NULL
│     ORDER BY failed_at ASC LIMIT $limit
├── For each:
│   ├── queue.add('dispatch', originalPayload, freshOptions)
│   └── UPDATE dead_letter_queue SET replayed_at = NOW()
└── Return { replayed: N, skipped: M, job_ids: [...] }
```

---

### 3.5 Database Schema (Full)

```sql
-- Dead Letter Queue
CREATE TABLE dead_letter_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          VARCHAR(255) NOT NULL UNIQUE,
  queue_name      VARCHAR(100) NOT NULL DEFAULT 'webhook-dispatch',
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

CREATE INDEX idx_dlq_failed_at    ON dead_letter_queue(failed_at DESC);
CREATE INDEX idx_dlq_job_id       ON dead_letter_queue(job_id);
CREATE INDEX idx_dlq_replayed_at  ON dead_letter_queue(replayed_at)
  WHERE replayed_at IS NULL;      -- partial index: only un-replayed rows
```

---

### 3.6 Redis Key Design

```
Key Pattern             TTL         Purpose
─────────────────────── ─────────── ─────────────────────────────────
idempotency:<uuid>      86400s      Blocks duplicate requests for 24h
bull:<queue>:jobs       persistent  BullMQ job state machine
bull:<queue>:waiting    persistent  Jobs waiting to be picked up
bull:<queue>:active     persistent  Jobs currently being processed
bull:<queue>:failed     persistent  Jobs that failed (before DLQ move)
bull:<queue>:completed  optional    Completed jobs (prunable)
```

---

### 3.7 Process Architecture

```
Docker Compose Network
─────────────────────────────────────────────────────────
┌─────────────────┐    ┌─────────────────┐
│   api (port 3000)│    │  worker          │
│                 │    │                 │
│  Express App    │    │  BullMQ Worker  │
│  - Routes       │    │  - dispatch.js  │
│  - Middleware   │    │  - retry.policy │
│  - Services     │    │  - dlq.service  │
│                 │    │  - signer       │
│  Starts: server.js   │  Starts: worker.js│
└────────┬────────┘    └────────┬────────┘
         │                     │
         │    ┌────────────────┐│
         └───►│  redis:6379    │◄┘
              │  (BullMQ +     │
              │  Idempotency)  │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │ mongo:27017  │
              │  (DLQ table)   │
              └────────────────┘
```

**Why two separate processes?**
- If the worker encounters a memory leak processing a huge payload → worker crashes.
- The API server keeps accepting new events uninterrupted.
- BullMQ's lock mechanism ensures the crashed job is re-delivered to the next worker instance.

---

## 4. API Contract

### `POST /webhooks/ingest`

```
Request:
  Header: Idempotency-Key: <uuid-v4>
  Body:   { "target_url": "https://...", "payload": { ...any... } }

Responses:
  202 → { "job_id": "bull:webhook-dispatch:42", "status": "queued" }
  400 → { "error": "MISSING_IDEMPOTENCY_KEY" | "INVALID_BODY" }
  409 → { "error": "DUPLICATE_REQUEST", "idempotency_key": "..." }
  503 → { "error": "QUEUE_UNAVAILABLE" }
```

### `POST /admin/retry-failed`

```
Request:
  Header: Authorization: Bearer <ADMIN_TOKEN>
  Body:   { "job_ids": ["uuid1"], "limit": 50 }   (one or the other)

Responses:
  200 → { "replayed": 3, "skipped": 1, "job_ids": ["...", "..."] }
  400 → { "error": "LIMIT_EXCEEDED" }
  401 → { "error": "UNAUTHORIZED" }
```

### `GET /health`

```
Response 200:
{
  "status": "ok",
  "redis": "connected",
  "mongodb": "connected",
  "worker": "alive",
  "uptime_seconds": 3842
}
```

---

## 5. Failure Mode Analysis

| Failure | What Happens | Recovery |
|---|---|---|
| Redis goes down mid-ingest | `503` returned to client, no job enqueued | Client retries with same `Idempotency-Key` once Redis recovers |
| Worker crashes during dispatch | BullMQ re-delivers job (lock expires in ~30s) | Next worker picks up the job |
| MongoDB DLQ write fails | Error logged as CRITICAL, job marked failed in Redis | Manual investigation; DLQ row was never written |
| Worker receives poison-pill | Retries 5 times with backoff, goes to DLQ | Other jobs in queue are unaffected |
| All 5 retries exhausted | Moves to MongoDB DLQ | Admin replays via `/admin/retry-failed` |
| Duplicate event from upstream | Second `SETNX` fails atomically | `409` returned, no second enqueue |

---

*Architecture document reflects implementation as of initial build. Update this document when any component boundary or data flow changes.*
