# 📦 Dispatch Queue Engine

> **Self-hosted webhook dispatcher with guaranteed delivery, automatic retries, deduplication, and dead-letter queue.**
> Deploy once. Never write webhook retry logic again.

---

## What Is This?

### Who Calls the Dispatcher?

> **The "client" is your own backend server — not a browser, not an end-user.**

Here is the actual real-world flow:

```
Your End-User                Your Backend Server           Dispatch Queue Engine
─────────────                ───────────────────           ─────────────────────

Hits your API    ─────────►  POST /checkout                
                             → payment confirmed            
                             → event triggered              
                             → YOUR SERVER calls ─────────► POST /webhooks/ingest
                               our dispatcher               (queues the job)
                                                            │
                                                            ▼
                                                      Worker dispatches
                                                      to your downstream
                                                      service (Slack, CRM,
                                                      email, etc.)
```

You host this engine **once**. Then inside your own backend code, anywhere an event happens, instead of directly calling the third-party API yourself, you call the dispatcher. The dispatcher takes responsibility for everything after that — retries, deduplication, signing, DLQ.

**Before (fragile — you wrote this):**
```javascript
// Your backend — POST /checkout handler
app.post('/checkout', async (req, res) => {
  await db.saveOrder(req.body);
  await axios.post('https://slack.com/webhook', { text: 'New order!' }); // 💥 what if Slack is down?
  res.json({ ok: true });
});
```

**After (resilient — dispatcher handles it):**
```javascript
// Your backend — POST /checkout handler
app.post('/checkout', async (req, res) => {
  await db.saveOrder(req.body);
  // 🔥 Just call the dispatcher. It handles retries, deduplication, signing.
  await axios.post('https://your-dispatcher.com/webhooks/ingest', {
    target_url: 'https://slack.com/webhook',
    payload: { text: 'New order!' }
  }, {
    headers: { 'Idempotency-Key': req.body.order_id }  // unique per order
  });
  res.json({ ok: true });  // responds immediately, delivery is async
});
```

Your API responds instantly. Delivery happens in the background with full retry guarantees.

---

## Prerequisites

Before you start, make sure you have:

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/) installed
- `git` installed
- Port `3000` available on your machine

> **No Node.js installation needed** — everything runs inside Docker.

---

## Quick Start (5 Minutes)

### Step 1 — Clone the Repository

```bash
git clone https://github.com/your-username/dispatch-queue-engine.git
cd dispatch-queue-engine/backend
```

### Step 2 — Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# The port the API server listens on
PORT=3000

# Redis connection (leave as-is if using docker-compose)
REDIS_HOST=redis
REDIS_PORT=6379

# PostgreSQL connection (leave as-is if using docker-compose)
DATABASE_URL=postgresql://postgres:password@postgres:5432/dispatch_engine

# HMAC signing secret — minimum 32 characters, keep this secret
WEBHOOK_SECRET=change-this-to-a-long-random-secret-string

# Admin token for the /admin/retry-failed endpoint
ADMIN_TOKEN=change-this-to-a-secure-admin-token
```

### Step 3 — Start Everything

```bash
docker compose up -d
```

This starts four containers:
- `api` → Express server on port 3000
- `worker` → BullMQ job processor (isolated from the API)
- `redis` → Job queue + idempotency key store
- `postgres` → Dead-letter queue storage

### Step 4 — Verify It's Running

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "redis": "connected",
  "postgres": "connected",
  "uptime_seconds": 12
}
```

**You're live.** 🎉

---

## Integration — How Your Server Calls the Dispatcher

### Your server fires this call whenever an event occurs in your system:

```bash
# Example: a payment just succeeded in your backend → call the dispatcher
curl -X POST http://localhost:3000/webhooks/ingest \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <your-unique-event-id>" \
  -d '{
    "target_url": "https://your-downstream-service.com/webhook",
    "payload": {
      "event": "payment.success",
      "amount": 9900,
      "currency": "INR",
      "order_id": "ORD-12345"
    }
  }'
```

> The `Idempotency-Key` should be your **event's natural unique ID** — e.g. `order_id`, `transaction_id`, or `event_id`. This ensures if your server accidentally sends the same event twice (retry on timeout), only one job gets queued.

**Dispatcher responds immediately:**
```json
{
  "job_id": "webhook-dispatch:42",
  "status": "queued"
}
```

**Then asynchronously, the dispatcher:**
1. Locks the `Idempotency-Key` in Redis (blocks any duplicate for 24 hours)
2. Signs the payload with HMAC-SHA256 → `X-Dispatch-Signature: sha256=...`
3. POSTs to `target_url` (your downstream service)
4. On failure → retries up to 5 times with exponential backoff
5. All 5 fail → stored in PostgreSQL DLQ, replayable anytime via admin API

### Integration in Node.js (inside your backend)

```javascript
const axios = require('axios');

async function dispatchEvent(eventId, targetUrl, payload) {
  return axios.post('http://your-dispatcher:3000/webhooks/ingest', {
    target_url: targetUrl,
    payload: payload
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': eventId   // use your event's natural unique ID
    }
  });
}

// Usage inside your checkout handler:
app.post('/checkout', async (req, res) => {
  const order = await db.saveOrder(req.body);

  // Fire-and-forget to dispatcher — your API responds instantly
  dispatchEvent(order.id, 'https://crm.example.com/hook', {
    event: 'order.created',
    order_id: order.id,
    amount: order.total
  });

  res.json({ ok: true, order_id: order.id });
});
```

### Integration in Python (inside your backend)

```python
import requests

def dispatch_event(event_id: str, target_url: str, payload: dict):
    requests.post(
        'http://your-dispatcher:3000/webhooks/ingest',
        json={'target_url': target_url, 'payload': payload},
        headers={
            'Content-Type': 'application/json',
            'Idempotency-Key': event_id  # your event's natural unique ID
        }
    )
```

---

## Idempotency — Blocking Duplicate Events

Every request **must** include an `Idempotency-Key` header (UUID v4 format).

```bash
# First request → 202 Accepted, job queued
curl -X POST http://localhost:3000/webhooks/ingest \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  ...

# Exact same key again → 409 Conflict (blocked, no duplicate job)
curl -X POST http://localhost:3000/webhooks/ingest \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  ...
```

The same key is blocked for **24 hours** after first use.

**Generating a UUID in code:**

```javascript
// Node.js
const { v4: uuidv4 } = require('uuid');
const key = uuidv4();
```

```python
# Python
import uuid
key = str(uuid.uuid4())
```

```bash
# bash / CI
KEY=$(uuidgen)
```

---

## Verifying Incoming Payloads (Downstream Service)

When the engine dispatches to your `target_url`, every request includes:

```
X-Dispatch-Signature: sha256=<hex>
```

Verify it in your downstream service:

```javascript
// Node.js verification
const crypto = require('crypto');

function verifyWebhook(req, secret) {
  const receivedSig = req.headers['x-dispatch-signature'];
  if (!receivedSig) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  const sigBuf = Buffer.from(receivedSig.replace('sha256=', ''), 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  // timingSafeEqual prevents timing attacks
  return sigBuf.length === expBuf.length &&
    crypto.timingSafeEqual(sigBuf, expBuf);
}

// In your Express route:
app.post('/webhook', (req, res) => {
  if (!verifyWebhook(req, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  // Process event...
  res.status(200).send('ok');
});
```

```python
# Python verification
import hmac, hashlib, json

def verify_webhook(body: dict, received_sig: str, secret: str) -> bool:
    payload = json.dumps(body, separators=(',', ':'))
    expected = hmac.new(
        secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    sig = received_sig.replace('sha256=', '')
    return hmac.compare_digest(expected, sig)
```

---

## Retry Behavior

You don't need to configure anything — retries are automatic.

| Attempt | Delay |
|---|---|
| 1 | Immediate |
| 2 | ~2 seconds |
| 3 | ~4 seconds |
| 4 | ~8 seconds |
| 5 | ~16 seconds |

After all 5 attempts fail, the job is moved to the dead-letter queue in PostgreSQL.

---

## Dead-Letter Queue — Replaying Failed Jobs

### View Failed Jobs

Connect to your PostgreSQL container:

```bash
docker compose exec postgres psql -U postgres -d dispatch_engine
```

```sql
-- See all failed jobs
SELECT job_id, target_url, error_message, attempt_count, failed_at
FROM dead_letter_queue
WHERE replayed_at IS NULL
ORDER BY failed_at DESC;
```

### Replay Specific Jobs

```bash
curl -X POST http://localhost:3000/admin/retry-failed \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "job_ids": [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    ]
  }'
```

### Replay the Oldest N Failed Jobs

```bash
curl -X POST http://localhost:3000/admin/retry-failed \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "limit": 20 }'
```

**Response:**
```json
{
  "replayed": 18,
  "skipped": 2,
  "job_ids": ["...", "...", "..."]
}
```

---

## API Reference

### `POST /webhooks/ingest`

| Field | Type | Required | Description |
|---|---|---|---|
| `target_url` | string (URL) | ✅ | Where to dispatch the payload |
| `payload` | object | ✅ | Any JSON object you want delivered |

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | ✅ | UUID v4. Blocks duplicates for 24h |
| `Content-Type` | ✅ | `application/json` |

| Status | Meaning |
|---|---|
| `202` | Job queued successfully |
| `400` | Missing/invalid body or Idempotency-Key |
| `409` | Duplicate — same key already used within 24h |
| `503` | Queue unavailable (Redis down) |

---

### `POST /admin/retry-failed`

| Header | Required | Description |
|---|---|---|
| `Authorization` | ✅ | `Bearer <ADMIN_TOKEN>` |

| Field | Type | Description |
|---|---|---|
| `job_ids` | string[] | Specific job IDs to replay |
| `limit` | number | Replay oldest N jobs (max 100) |

---

### `GET /health`

No authentication required.

```json
{
  "status": "ok",
  "redis": "connected",
  "postgres": "connected",
  "uptime_seconds": 3842
}
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | API server port |
| `REDIS_HOST` | Yes | — | Redis hostname |
| `REDIS_PORT` | No | `6379` | Redis port |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `WEBHOOK_SECRET` | Yes | — | HMAC signing secret (min 32 chars) |
| `ADMIN_TOKEN` | Yes | — | Bearer token for admin endpoints |
| `QUEUE_NAME` | No | `webhook-dispatch` | BullMQ queue name |
| `MAX_RETRIES` | No | `5` | Number of retry attempts |
| `JOB_TIMEOUT_MS` | No | `10000` | Per-attempt HTTP timeout (ms) |
| `IDEMPOTENCY_TTL_SECONDS` | No | `86400` | Idempotency key lifetime (24h) |

---

## Running Without Docker (Development)

If you want to run locally with your own Redis and PostgreSQL:

```bash
# Install dependencies
npm install

# Create the DLQ table
psql $DATABASE_URL -f src/db/migrations/001_create_dlq.sql

# Start API server
npm run start:api

# Start worker in a separate terminal
npm run start:worker
```

---

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Watch mode
npm run test:watch
```

---

## Scaling Workers

To handle higher throughput, run multiple worker replicas:

```bash
# Scale to 3 worker containers
docker compose up -d --scale worker=3
```

BullMQ uses Redis-based distributed locking — multiple workers process jobs concurrently without conflicts or double-processing.

---

## Stopping the Engine

```bash
# Stop all containers
docker compose down

# Stop and delete all data (Redis + PostgreSQL volumes)
docker compose down -v
```

---

## Troubleshooting

### `409 Conflict` on every request
Your `Idempotency-Key` was already used. Generate a new UUID for each unique event.

### Jobs not being dispatched
Check the worker is running:
```bash
docker compose logs worker --tail=50
```

### DLQ filling up
Your `target_url` may be consistently unreachable. Check:
1. The URL is publicly accessible from inside Docker
2. The downstream service is returning 2xx responses
3. No firewall is blocking outbound requests from the container

### Redis connection refused
```bash
docker compose logs redis
docker compose restart redis
```

---

## License

MIT — free to use, host, and modify.
