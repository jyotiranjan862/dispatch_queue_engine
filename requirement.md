# Dispatch Queue Engine — Webhook Dispatcher & BYOB Management Plane

> **Stack: Express.js · BullMQ · Redis 7 · MongoDB 7 · Docker Compose · TypeScript**

---

## 1. The Real Problem

Most engineering teams write webhook integrations synchronously:

```
Client fires HTTP request → Your server → Immediately calls third-party API
```

This breaks in production every single day:

| Actual Problem | What Happens in Reality |
|---|---|
| **Duplicate Events** | Stripe, payment gateways, or network retries fire the same event twice. Your server processes the event twice; money is charged twice or records duplicate. |
| **Downstream Outages** | Downstream third-party APIs (Slack, email service, partner CRM) suffer brief outages. Your server returns 500. The event is **permanently lost**. |
| **No Retry Logic** | A basic `try/catch` logs an error and moves on. Up to 40% of webhook events can silently disappear under network partitions. |
| **Crash Propagation** | One malformed or oversized payload crashes an unshielded Node.js process, dropping in-flight requests. |
| **No Visibility & Audit Trail** | Nobody knows which events failed, which target rejected the call, what the HTTP response was, or how to replay failures safely. |

---

## 2. How This System Solves It

**Dispatch Queue Engine** is a self-hosted, drop-in webhook dispatcher paired with a zero-cost **Hosted Management UI (Bring Your Own Backend)**.

```
Before:  Client → Your Server → Third-party API    (fragile, synchronous, no retry)

After:   Client → Dispatch Engine → Queue → Worker → Third-party API
                        ↓                      ↓
                 Duplicate blocked        Auto-retry with jitter
                 in < 1ms (Redis)         → DLQ in MongoDB if all 5 fail
                                               │
                                               ▼
                                      Replayable via Hosted Dashboard
```

Anyone can host this on their own infrastructure (`docker compose up -d`), enter their backend URL into the **Hosted Web Dashboard**, and **never write custom webhook retry logic again**.

---

## 3. Functional Requirements

### FR-1: Idempotent Webhook Ingestion with Project Authentication

**Endpoint:** `POST /webhooks/ingest`

**Headers:**
```
X-Project-Key: <project-api-key>       [Required]
Idempotency-Key: <uuid-v4>             [Required]
Content-Type: application/json         [Required]
```

**Behavior:**
1. Validate `X-Project-Key` against the `projects` collection in MongoDB. Reject `401 Unauthorized` if missing, invalid, or archived.
2. Validate `Idempotency-Key` format (UUID v4). Reject `400 Bad Request` if invalid.
3. Atomic Redis check: `SET idempotency:<key> "queued" NX EX 86400` (24-hour TTL).
   - Key already exists → Return `409 Conflict` (< 1ms).
   - Key is unique → Lock acquired.
4. Enqueue job into BullMQ tagged with project metadata (`projectId`, `projectSlug`, `webhookSecret`).
5. Return `202 Accepted` with `{ "job_id": "...", "project": { "id": "...", "slug": "..." }, "status": "queued" }` in **< 20ms**.
6. If queue insertion fails, release the Redis lock immediately so the client can safely retry.

---

### FR-2: Queue Worker with Jittered Exponential Backoff

**Process:** Separate Node.js process (`src/worker.ts`), isolated from the API server.

**Retry Schedule:**
* **Attempt 1:** Immediate.
* **Attempt 2:** $2^1 \times 1000\text{ms} + \text{random}(0, 500\text{ms}) \approx 2.0\text{s} - 2.5\text{s}$
* **Attempt 3:** $2^2 \times 1000\text{ms} + \text{random}(0, 500\text{ms}) \approx 4.0\text{s} - 4.5\text{s}$
* **Attempt 4:** $2^3 \times 1000\text{ms} + \text{random}(0, 500\text{ms}) \approx 8.0\text{s} - 8.5\text{s}$
* **Attempt 5:** $2^4 \times 1000\text{ms} + \text{random}(0, 500\text{ms}) \approx 16.0\text{s} - 16.5\text{s}$

**Rules:**
- **Randomized Jitter**: Prevents synchronized retry storms (thundering herd problem).
- **Hard Timeout**: 10-second request timeout per attempt.
- **Worker Crash Resilience**: BullMQ distributed locks reassign jobs if a worker abruptly dies.

---

### FR-3: Per-Project HMAC-SHA256 Payload Signing

Every outgoing HTTP request sent to a downstream destination carries a signature header:
```
X-Dispatch-Signature: sha256=<hex_digest>
```
- Computed using the specific project's `webhookSecret` (auto-generated during project creation).
- Downstream services verify authenticity using timing-safe cryptographic comparisons.

---

### FR-4: Dead-Letter Queue (DLQ) Persistence

**Trigger:** Job fails all 5 retry attempts or encounters an unrecoverable error.

**MongoDB Schema:**
```typescript
// dead_letter_queues collection
{
  projectId: ObjectId,          // Ref to Project
  projectSlug: String,          // Human-readable project tag
  jobId: String,                // Unique identifier
  idempotencyKey: String,       // Ingest event key
  targetUrl: String,            // Destination URL
  payload: Mixed,               // Original raw payload
  attemptsMade: Number,         // Default: 5
  lastError: {
    message: String,            // Error message
    code: String,               // Optional HTTP or Node error code
    stack: String,              // Complete stack trace for debugging
    timestamp: Date
  },
  status: 'pending' | 'replaying' | 'replayed' | 'exhausted',
  replayedAt: Date,
  replayedJobId: String,
  createdAt: Date,
  updatedAt: Date
}
```

- DLQ write failure is logged as `CRITICAL` but does not crash the worker process.
- Compound indexes ensure fast dashboard queries: `{ projectId: 1, status: 1, createdAt: -1 }`.

---

### FR-5: Project Management & DLQ Replay APIs

All endpoints protected by `Authorization: Bearer <JWT>` issued via `POST /api/admin/login`:

1. **`POST /api/projects`**: Register project; auto-generates API key and signing secret.
2. **`GET /api/projects`**: List projects with pagination and status filters.
3. **`POST /api/projects/:id/rotate-keys`**: Rotate API key and webhook secret.
4. **`GET /api/projects/:id/dlq`**: List paginated failures for a specific project.
5. **`GET /api/projects/:id/dlq/stats`**: Get breakdown (`pending`, `replaying`, `replayed`, `exhausted`).
6. **`POST /api/projects/:id/dlq/replay/:jobId`**: Re-enqueue a single failed job with a fresh Job ID.
7. **`POST /api/projects/:id/dlq/replay-all`**: Bulk re-enqueue all pending/exhausted failed jobs for the project.

---

### FR-6: Hosted Management Dashboard (BYOB Model)

**Concept:** A centrally-hosted static SPA (e.g., hosted on Vercel / GitHub Pages) that allows developers to manage their self-hosted instances with **zero hosting cost or data liability** to the maintainer.

**Capabilities:**
1. **Connection Screen**: User inputs their self-hosted backend URL (`http://localhost:3000` or `https://dispatch.domain.com`) and `ADMIN_TOKEN`.
2. **Client-Side Auth**: Calls `POST /api/admin/login` on the user's backend, receives a JWT, and stores it in browser session storage.
3. **Projects Workspace**: Create projects, view credentials, rotate keys, and copy integration code snippets.
4. **DLQ Console**: Search and filter failed events, inspect JSON payloads and error stack traces in a modal, and trigger single or bulk replays.

---

## 4. Non-Functional Requirements

### Performance
- **Ingest API**: **< 20ms p99** at 200 RPS (Redis atomic check + BullMQ enqueue).
- **Worker**: **> 100 dispatches/minute** per worker container replica.

### Reliability
- In-flight jobs survive worker crashes via BullMQ distributed locks.
- MongoDB and Redis data persisted on named Docker volumes.

### Security
- **No Hardcoded Secrets**: All configuration loaded from `.env` and validated via Zod.
- **CORS Management**: Configurable via `CORS_ORIGIN` to support the Hosted Dashboard URL.
- **Payload Cap**: Max 1MB body limit prevents memory exhaustion.
- **UUID v4 Validation**: Prevents arbitrary key injection into Redis keyspaces.

### Observability
- Structured JSON logging (Winston) with timestamp, log level, and contextual job IDs.
- `GET /health` endpoint checks Redis ping and MongoDB replica state.

---

## 5. Architectural Decisions Traceability

| Decision | Rationale |
|---|---|
| **BullMQ over Raw Redis** | Built-in distributed state machine, exponential retry backoff hooks, and worker crash recovery. |
| **Separate Worker Process** | Fault isolation: a worker process running out of memory processing a heavy payload will not take down the API. |
| **MongoDB for DLQ & Projects** | Persistent, queryable, supports indexing on complex payload JSON, and survives Redis cache evictions. |
| **BYOB Hosted UI** | Users get a rich modern web UI out of the box, while the maintainer has zero hosting costs, zero database overhead, and zero privacy liability. |
| **Atomic SETNX Locks** | Guarantees exact-once ingestion within 24h, eliminating concurrency race conditions. |
