# Dispatch Queue Engine

> **Self-hosted webhook dispatcher with guaranteed delivery, automatic retries, deduplication, and dead-letter queue — paired with a zero-cost Hosted Management UI (Bring Your Own Backend).**  
> Deploy once on your infrastructure. Never write webhook retry or queueing logic again.

> 📚 **API & Tooling**: [Full API Documentation](docs/API_DOCUMENTATION.md) · [Postman Collection](docs/dispatch_queue_engine.postman_collection.json) · [Postman Environment](docs/dispatch_queue_engine.postman_environment.json) · [Architecture Guide](architecture.md)

---

## What Is This?

### The Architecture: Self-Hosted Backend + Hosted Admin UI (BYOB)

Dispatch Queue Engine consists of two seamless parts:

1. **Self-Hosted Engine (Your Infrastructure)**: A production-ready Docker Compose bundle running an Express API, BullMQ Worker, Redis 7, and MongoDB 7 on your own server or VPC. Your payload data, database, and webhook events **never leave your infrastructure**.
2. **Hosted Admin Dashboard (Zero Server Cost for You)**: A static, client-side web application (hosted on Vercel / GitHub Pages). You simply open the dashboard, enter your engine's URL (`http://localhost:3000` or `https://dispatch.yourdomain.com`) and your `ADMIN_TOKEN`, and manage your projects, credentials, and Dead-Letter Queue (DLQ) directly from your browser.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HOSTED ADMIN DASHBOARD (Static Web UI on Vercel / GitHub Pages)         │
│ • Runs 100% in your browser • Zero customer data stored centrally       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Direct browser REST calls
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ YOUR SELF-HOSTED DISPATCH ENGINE (Docker Compose on your server/VPC)    │
│                                                                         │
│   Your Backend Server (Client)                                          │
│   (Payment, Auth, Order Service)                                        │
│               │                                                         │
│               │ POST /webhooks/ingest                                   │
│               │ Headers: X-Project-Key, Idempotency-Key                 │
│               ▼                                                         │
│      ┌─────────────────┐       ┌─────────────────┐                      │
│      │ Dispatch API    ├──────►│ Redis 7         │                      │
│      │ (:3000)         │       │ Queue + Locks   │                      │
│      └────────┬────────┘       └────────┬────────┘                      │
│               │                         │                               │
│               ▼                         ▼                               │
│      ┌─────────────────┐       ┌─────────────────┐                      │
│      │ MongoDB 7       │       │ Dispatch Worker │                      │
│      │ Projects + DLQ  │◄──────┤ (Isolated Proc) │                      │
│      └─────────────────┘       └────────┬────────┘                      │
└─────────────────────────────────────────┼───────────────────────────────┘
                                          │ POST (HMAC Signed)
                                          ▼
                         ┌─────────────────────────────────┐
                         │ Downstream API (Slack/CRM/Stripe)│
                         └─────────────────────────────────┘
```

---

## Why Use This?

Most engineering teams build webhook calls synchronously:
```
Your Server ──(HTTP POST)──► Third-Party API (Slack, Stripe, CRM)
```
When downstream APIs go down, your app drops events or hangs threads.

With **Dispatch Queue Engine**:
- **Atomic Deduplication**: Same idempotency key cannot be processed twice within 24 hours (< 1ms Redis lock).
- **Exponential Backoff with Jitter**: Automatic 5-attempt retry schedule ($2^n \times 1000\text{ms} + \text{random jitter}$), preventing thundering herds.
- **HMAC-SHA256 Cryptographic Signing**: Every outgoing webhook is cryptographically signed with your project's unique secret.
- **Dead-Letter Queue (DLQ)**: Every exhausted job is captured in MongoDB with full stack traces, inspectable and replayable with one click in the dashboard.
- **Multi-Project Segregation**: Issue isolated API keys for different environments (Production, Staging) or microservices.

---

## Quick Start (5 Minutes)

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/)
- Port `3000`, `6379`, and `27017` available

---

### Step 1 — Clone and Configure

```bash
git clone https://github.com/your-username/dispatch-queue-engine.git
cd dispatch-queue-engine/backend
cp .env.example .env
```

Open `.env` and configure your security keys:

```env
PORT=3000
NODE_ENV=development

# Admin secret used to generate your JWT sessions in the dashboard
ADMIN_TOKEN=your-secure-admin-token-here

# JWT signing secret (min 16 chars)
JWT_SECRET=super_secret_jwt_key_at_least_32_chars_long

# Webhook signature secret fallback
WEBHOOK_SECRET=fallback_webhook_secret_key_at_least_32_chars

# CORS: Allow requests from the Hosted Admin Dashboard
# Use * in development, or your dashboard domain (e.g. https://dispatch-ui.vercel.app)
CORS_ORIGIN=*
```

---

### Step 2 — Start the Engine

```bash
docker compose up -d
```

This launches 4 isolated containers:
1. `dispatch_api` — Express API server on port `3000`
2. `dispatch_worker` — BullMQ background worker
3. `dispatch_redis` — In-memory queue & idempotency lock manager
4. `dispatch_mongo` — Persistent storage for projects & DLQ records

Verify health:
```bash
curl http://localhost:3000/health
```
Expected response:
```json
{
  "status": "ok",
  "redis": "connected",
  "mongodb": "connected",
  "uptime_seconds": 15
}
```

---

### Step 3 — Open the Hosted Dashboard & Create a Project

1. Open the Hosted Web Dashboard: `https://dispatch-ui.vercel.app` (or your custom dashboard URL).
2. Enter your **Engine API URL** (`http://localhost:3000` for local, or your production URL) and your `ADMIN_TOKEN`.
3. Click **Connect**.
4. In the **Projects** tab, click **Create Project** (e.g., `Production Orders`).
5. Copy your generated:
   - **Project API Key** (e.g. `proj_live_abc123...`)
   - **Webhook Secret** (used by downstream services to verify incoming HMAC signatures)

---

### Step 4 — Ingest Webhooks from Your Server

Inside your own backend application, dispatch events to the engine:

#### cURL
```bash
curl -X POST http://localhost:3000/webhooks/ingest \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: proj_live_abc123..." \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "target_url": "https://api.yourdomain.com/webhooks/orders",
    "payload": {
      "event": "order.completed",
      "order_id": "ORD-9921",
      "amount": 4900
    }
  }'
```

**Immediate Response (< 20ms):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "project": {
    "id": "6790a1b...",
    "slug": "production-orders"
  },
  "status": "queued",
  "timestamp": "2026-09-22T12:00:00.000Z"
}
```

---

## Code Integration Examples

### Node.js (TypeScript / Express)

```typescript
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const DISPATCHER_URL = process.env.DISPATCHER_URL || 'http://localhost:3000';
const PROJECT_API_KEY = process.env.DISPATCH_PROJECT_KEY!;

export async function dispatchWebhook(targetUrl: string, payload: Record<string, unknown>, naturalEventId?: string) {
  const idempotencyKey = naturalEventId || uuidv4();

  return axios.post(
    `${DISPATCHER_URL}/webhooks/ingest`,
    {
      target_url: targetUrl,
      payload,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': PROJECT_API_KEY,
        'Idempotency-Key': idempotencyKey,
      },
      timeout: 5000,
    },
  );
}

// Inside your checkout route:
app.post('/api/checkout', async (req, res) => {
  const order = await db.createOrder(req.body);

  // Non-blocking fire-and-forget to the dispatcher:
  dispatchWebhook('https://crm.partner.com/webhook', {
    event: 'order.placed',
    orderId: order.id,
    total: order.amount,
  }, order.id);

  res.status(200).json({ success: true, orderId: order.id });
});
```

### Python (FastAPI / Django)

```python
import uuid
import requests

DISPATCHER_URL = "http://localhost:3000"
PROJECT_API_KEY = "proj_live_abc123..."

def send_webhook(target_url: str, payload: dict, event_id: str = None):
    idempotency_key = event_id or str(uuid.uuid4())
    
    response = requests.post(
        f"{DISPATCHER_URL}/webhooks/ingest",
        json={"target_url": target_url, "payload": payload},
        headers={
            "Content-Type": "application/json",
            "X-Project-Key": PROJECT_API_KEY,
            "Idempotency-Key": idempotency_key,
        },
        timeout=5,
    )
    return response.json()
```

---

## Verifying Incoming Webhooks (Downstream Service)

Every HTTP request dispatched by the engine contains a cryptographic signature:
```
X-Dispatch-Signature: sha256=<hex_signature>
```

Verify it in your destination service to ensure the payload was not tampered with:

```typescript
import crypto from 'crypto';

export function verifyDispatchSignature(
  rawBody: string,
  receivedHeader: string,
  projectWebhookSecret: string,
): boolean {
  if (!receivedHeader || !receivedHeader.startsWith('sha256=')) return false;

  const expectedSignature = crypto
    .createHmac('sha256', projectWebhookSecret)
    .update(rawBody)
    .digest('hex');

  const receivedSignature = receivedHeader.replace('sha256=', '');

  return crypto.timingSafeEqual(
    Buffer.from(receivedSignature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  );
}
```

---

## Dead-Letter Queue (DLQ) & Failure Recovery

When a webhook destination consistently fails (e.g. 500 Server Error, timeout, or unreachable host), the worker attempts 5 exponential retries with randomized jitter:

```
Attempt 1: immediate
Attempt 2: ~2s (+ 0-500ms jitter)
Attempt 3: ~4s (+ 0-500ms jitter)
Attempt 4: ~8s (+ 0-500ms jitter)
Attempt 5: ~16s (+ 0-500ms jitter)
```

If all 5 attempts fail:
1. The event is captured in MongoDB under `dead_letter_queues` with `status: 'pending'`.
2. The full `error.message` and `error.stack` are preserved for debugging.
3. You can inspect the failure in the **Hosted Dashboard** and click **Replay Job** or **Bulk Replay**.

### Programmatic Replay via REST API

```bash
# Authenticate Admin and get JWT
TOKEN=$(curl -s -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"adminToken":"your-secure-admin-token-here"}' | jq -r '.data.token')

# Replay a specific dead-letter job
curl -X POST http://localhost:3000/api/projects/<PROJECT_ID>/dlq/replay/<JOB_ID> \
  -H "Authorization: Bearer $TOKEN"

# Bulk replay all pending failed jobs for a project
curl -X POST http://localhost:3000/api/projects/<PROJECT_ID>/dlq/replay-all \
  -H "Authorization: Bearer $TOKEN"
```

---

## Complete API Reference

### Webhook Ingestion
* **`POST /webhooks/ingest`**
  * **Headers**: `X-Project-Key` (required), `Idempotency-Key` (UUID v4 required).
  * **Body**: `{ "target_url": "https://...", "payload": { ... } }`
  * **Status Codes**:
    * `202`: Enqueued successfully.
    * `400`: Missing or invalid URL / Idempotency-Key.
    * `401`: Invalid or archived Project Key.
    * `409`: Duplicate event detected (blocked by Redis within 24h).
    * `503`: Redis / DB unavailable.

### Admin Authentication
* **`POST /api/admin/login`**: Body: `{ "adminToken": "..." }` → Returns JWT (`expiresIn: "24h"`).
* **`GET /api/admin/me`**: Validates active admin session.
* **`GET /api/admin/stats`**: System overview (projects count, global DLQ totals).

### Project & DLQ Control Plane (Protected by `Bearer <JWT>`)
* **`POST /api/projects`**: Create project (`{ "name": "...", "slug": "...", "description": "..." }`).
* **`GET /api/projects`**: List projects (`?status=active&limit=50&skip=0`).
* **`GET /api/projects/:id`**: Get project details and credentials.
* **`PATCH /api/projects/:id`**: Update project metadata or status.
* **`POST /api/projects/:id/rotate-keys`**: Regenerate API Key and Webhook Secret.
* **`DELETE /api/projects/:id`**: Soft-archive project.
* **`GET /api/projects/:id/dlq`**: List DLQ entries (`?status=pending&limit=50&skip=0`).
* **`GET /api/projects/:id/dlq/stats`**: Get DLQ metrics for project.
* **`POST /api/projects/:id/dlq/replay/:jobId`**: Replay specific failed job.
* **`POST /api/projects/:id/dlq/replay-all`**: Replay all failed jobs for project.

### System Health
* **`GET /health`**: Public healthcheck for Redis, MongoDB, and uptime.

---

## Scaling Workers

To scale delivery throughput under heavy load, scale the worker container:

```bash
docker compose up -d --scale worker=4
```

BullMQ's distributed Redis lock guarantees that jobs are consumed concurrently without double-processing or conflicts.

---

## Stopping the Service

```bash
# Stop containers (preserves Redis & MongoDB data)
docker compose down

# Stop and wipe all persistent data
docker compose down -v
```

---

## License

MIT — free to use, self-host, and modify.
