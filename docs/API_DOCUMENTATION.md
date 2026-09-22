# Dispatch Queue Engine — API Documentation & Postman Guide

> **Version:** 1.0.0  
> **Base URL:** `http://localhost:3000` (or your production deployment URL)  
> **Format:** RESTful JSON  
> **Postman Files:**
> - [Postman Collection](file:///d:/AkashProjects/resume_project/dispatch_queu_engine/backend/docs/dispatch_queue_engine.postman_collection.json)
> - [Postman Environment](file:///d:/AkashProjects/resume_project/dispatch_queu_engine/backend/docs/dispatch_queue_engine.postman_environment.json)

---

## Table of Contents

1. [Quickstart with Postman](#quickstart-with-postman)
2. [Authentication & Authorization](#authentication--authorization)
3. [System & Health Endpoints](#1-system--health)
4. [Admin Management Endpoints](#2-admin-management)
5. [Project Management Endpoints](#3-project-management)
6. [Dead-Letter Queue (DLQ) & Replay](#4-dead-letter-queue-dlq--replay)
7. [Webhook Ingestion (Client Microservices)](#5-webhook-ingestion)
8. [Downstream Signature Verification (HMAC-SHA256)](#downstream-signature-verification)
9. [Standard Error Responses](#standard-error-responses)

---

## Quickstart with Postman

### 1. Import Files into Postman
1. Open **Postman**.
2. Click **Import** (top left).
3. Select both files located in the `backend/docs/` directory:
   * `dispatch_queue_engine.postman_collection.json`
   * `dispatch_queue_engine.postman_environment.json`
4. In the top-right environment selector, choose **"Dispatch Queue Engine (Local)"**.

### 2. Run the End-to-End Test Flow (Chained Automation)
The collection includes **automatic test scripts** that save variables into your Postman environment as you make requests:
1. Run **`POST /api/admin/login`**:
   * Automatically extracts the signed JWT and saves it to `{{bearerToken}}`.
2. Run **`POST /api/projects`**:
   * Automatically extracts the created `id` $\to$ `{{projectId}}` and `apiKey` $\to$ `{{projectApiKey}}`.
3. Run **`POST /webhooks/ingest`**:
   * Automatically generates a fresh UUID v4 for `Idempotency-Key` and authenticates with `{{projectApiKey}}`.
4. Run **`GET /api/projects/:id/dlq`**:
   * Automatically captures any failed job ID to `{{failedJobId}}` for single-job replay tests.

---

## Authentication & Authorization

The engine uses two distinct authentication mechanisms depending on the caller:

| Area | Header Required | Description |
|---|---|---|
| **Admin Control Plane** | `Authorization: Bearer <JWT>` | Required for `/api/admin/*` and `/api/projects/*`. Obtained via `POST /api/admin/login`. |
| **System Admin Bypass** | `X-Admin-Token: <ADMIN_TOKEN>` | Alternative fallback for internal CLI scripts and admin operations. |
| **Webhook Ingestion** | `X-Project-Key: <PROJECT_API_KEY>` | Required for `POST /webhooks/ingest`. Segregates webhooks by project. |
| **Event Idempotency** | `Idempotency-Key: <UUID_V4>` | Required for `POST /webhooks/ingest`. Enforces 24-hour deduplication in Redis. |

---

## 1. System & Health

### Root Service Info
Returns the engine version and operational status.

* **Method:** `GET`
* **Path:** `/`
* **Auth:** None (Public)

#### Example Request
```bash
curl -X GET http://localhost:3000/
```

#### Example Response (`200 OK`)
```json
{
  "name": "dispatch-queue-engine",
  "version": "1.0.0",
  "status": "running"
}
```

---

### System Health Check
Verifies connectivity to Redis and MongoDB. Ideal for container probes (Kubernetes liveness/readiness, Docker healthchecks).

* **Method:** `GET`
* **Path:** `/health`
* **Auth:** None (Public)

#### Example Request
```bash
curl -X GET http://localhost:3000/health
```

#### Example Response (`200 OK`)
```json
{
  "status": "ok",
  "redis": "connected",
  "mongodb": "connected",
  "uptime_seconds": 240,
  "timestamp": "2026-09-22T14:30:00.000Z"
}
```

*Status is `503 Service Unavailable` if Redis or MongoDB is disconnected.*

---

## 2. Admin Management

### Admin Login
Exchanges the instance's master `ADMIN_TOKEN` for a signed JSON Web Token (JWT) valid for 24 hours.

* **Method:** `POST`
* **Path:** `/api/admin/login`
* **Auth:** None (Public)
* **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "adminToken": "dev_admin_bearer_token_12345"
}
```

#### Example Request
```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"adminToken": "dev_admin_bearer_token_12345"}'
```

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": "24h",
    "role": "admin"
  }
}
```

---

### Get Current Admin Session
Verifies the current JWT session.

* **Method:** `GET`
* **Path:** `/api/admin/me`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "admin": {
      "sub": "admin",
      "role": "admin"
    }
  }
}
```

---

### Get Global Admin Stats
Returns instance-wide aggregated statistics for the management dashboard.

* **Method:** `GET`
* **Path:** `/api/admin/stats`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "projects": {
      "total": 4,
      "active": 3,
      "archived": 1
    },
    "dlq": {
      "pending": 8,
      "replaying": 0,
      "replayed": 142,
      "exhausted": 2,
      "total": 152
    }
  }
}
```

---

## 3. Project Management

Projects isolate webhook delivery, cryptographic secrets, and dead-letter queues.

### Create Project
Registers a new project and generates its API key and signing secret.

* **Method:** `POST`
* **Path:** `/api/projects`
* **Headers:**
  * `Authorization: Bearer <TOKEN>`
  * `Content-Type: application/json`

#### Request Body
```json
{
  "name": "Billing & Invoices",
  "slug": "billing-invoices",
  "description": "Handles all invoice and payment dispatch events"
}
```

#### Example Response (`201 Created`)
```json
{
  "status": "success",
  "data": {
    "id": "6790a1b2c3d4e5f6a7b8c9d0",
    "name": "Billing & Invoices",
    "slug": "billing-invoices",
    "apiKey": "dqe_live_9f8e7d6c5b4a39281726...",
    "webhookSecret": "a1b2c3d4e5f67890abcdef...",
    "description": "Handles all invoice and payment dispatch events",
    "status": "active",
    "createdAt": "2026-09-22T14:32:00.000Z"
  }
}
```

---

### List Projects
Retrieves paginated projects.

* **Method:** `GET`
* **Path:** `/api/projects`
* **Headers:** `Authorization: Bearer <TOKEN>`
* **Query Parameters:**
  * `status`: `active` or `archived` (optional)
  * `limit`: Page size (default: 50, max: 100)
  * `skip`: Number of records to skip (default: 0)

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "projects": [
      {
        "id": "6790a1b2c3d4e5f6a7b8c9d0",
        "name": "Billing & Invoices",
        "slug": "billing-invoices",
        "apiKey": "dqe_live_9f8e7d6c...",
        "webhookSecret": "a1b2c3d4...",
        "status": "active",
        "createdAt": "2026-09-22T14:32:00.000Z",
        "updatedAt": "2026-09-22T14:32:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "limit": 50,
      "skip": 0
    }
  }
}
```

---

### Get Project By ID
* **Method:** `GET`
* **Path:** `/api/projects/:id`
* **Headers:** `Authorization: Bearer <TOKEN>`

---

### Update Project
Updates project name, description, or status.

* **Method:** `PATCH`
* **Path:** `/api/projects/:id`
* **Headers:**
  * `Authorization: Bearer <TOKEN>`
  * `Content-Type: application/json`

#### Request Body
```json
{
  "name": "Billing & Invoicing Service",
  "description": "Updated project description"
}
```

---

### Rotate Project Keys
Regenerates the project's API Key and HMAC Webhook Secret. The old keys are immediately invalidated in the Redis cache.

* **Method:** `POST`
* **Path:** `/api/projects/:id/rotate-keys`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "message": "Project credentials successfully rotated",
  "data": {
    "id": "6790a1b2c3d4e5f6a7b8c9d0",
    "slug": "billing-invoices",
    "newApiKey": "dqe_live_new_key_hex...",
    "newWebhookSecret": "new_secret_hex..."
  }
}
```

---

### Archive Project (Soft Delete)
Archives a project. Any subsequent ingestion requests using this project's API key will be rejected with `401 Unauthorized`.

* **Method:** `DELETE`
* **Path:** `/api/projects/:id`
* **Headers:** `Authorization: Bearer <TOKEN>`

---

## 4. Dead-Letter Queue (DLQ) & Replay

### Get Project DLQ Records
Returns paginated dead-letter records for this project, including error stack traces and original payloads.

* **Method:** `GET`
* **Path:** `/api/projects/:id/dlq`
* **Headers:** `Authorization: Bearer <TOKEN>`
* **Query Parameters:**
  * `status`: `pending`, `replaying`, `replayed`, or `exhausted` (optional)
  * `limit`: Page limit (default: 50)
  * `skip`: Page offset (default: 0)

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "records": [
      {
        "_id": "6790b2c3d4e5f6a7b8c9d0e1",
        "projectId": "6790a1b2c3d4e5f6a7b8c9d0",
        "projectSlug": "billing-invoices",
        "jobId": "550e8400-e29b-41d4-a716-446655440000",
        "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
        "targetUrl": "https://api.external.com/failed-endpoint",
        "payload": {
          "orderId": "ORD-1002",
          "amount": 9900
        },
        "attemptsMade": 5,
        "lastError": {
          "message": "connect ECONNREFUSED 192.0.2.1:443",
          "stack": "Error: connect ECONNREFUSED...\n    at Axios.request...",
          "timestamp": "2026-09-22T14:40:00.000Z"
        },
        "status": "pending",
        "createdAt": "2026-09-22T14:40:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "limit": 50,
      "skip": 0
    }
  }
}
```

---

### Get Project DLQ Stats
Returns DLQ counter breakdown for the project.

* **Method:** `GET`
* **Path:** `/api/projects/:id/dlq/stats`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "data": {
    "pending": 3,
    "replaying": 0,
    "replayed": 12,
    "exhausted": 1,
    "total": 16
  }
}
```

---

### Replay Specific DLQ Job
Re-enqueues a specific exhausted job into the active BullMQ queue for redelivery.

* **Method:** `POST`
* **Path:** `/api/projects/:id/dlq/replay/:jobId`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "message": "DLQ job \"550e8400-...\" re-enqueued for delivery",
  "data": {
    "originalJobId": "550e8400-e29b-41d4-a716-446655440000",
    "replayedJobId": "a1b2c3d4-e5f6-7890-abcd-112233445566",
    "status": "replayed",
    "replayedAt": "2026-09-22T14:45:00.000Z"
  }
}
```

---

### Bulk Replay All DLQ Jobs
Re-enqueues all pending and exhausted dead-letter jobs for this project.

* **Method:** `POST`
* **Path:** `/api/projects/:id/dlq/replay-all`
* **Headers:** `Authorization: Bearer <TOKEN>`

#### Example Response (`200 OK`)
```json
{
  "status": "success",
  "message": "Bulk replay completed. Re-enqueued 5 dead-letter jobs.",
  "data": {
    "replayedCount": 5,
    "jobIds": ["550e8400-...", "661f9511-..."]
  }
}
```

---

## 5. Webhook Ingestion

Dispatches an event asynchronously. This is the primary endpoint called by your backend applications.

* **Method:** `POST`
* **Path:** `/webhooks/ingest`
* **Headers:**
  * `X-Project-Key: <PROJECT_API_KEY>` (or `X-API-Key`)
  * `Idempotency-Key: <UUID_V4>`
  * `Content-Type: application/json`

#### Request Body
```json
{
  "target_url": "https://api.thirdparty.com/webhook",
  "payload": {
    "event": "order.completed",
    "orderId": "ORD-98214",
    "amount": 4900,
    "currency": "INR"
  }
}
```

#### Example Request
```bash
curl -X POST http://localhost:3000/webhooks/ingest \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: dqe_live_9f8e7d6c5b4a..." \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "target_url": "https://api.thirdparty.com/webhook",
    "payload": {
      "event": "order.completed",
      "orderId": "ORD-98214",
      "amount": 4900
    }
  }'
```

#### Example Response (`202 Accepted`) — Response in < 20ms
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "project": {
    "id": "6790a1b2c3d4e5f6a7b8c9d0",
    "slug": "billing-invoices"
  },
  "status": "queued",
  "timestamp": "2026-09-22T14:48:00.000Z"
}
```

#### Duplicate Event Response (`409 Conflict`)
If the same `Idempotency-Key` is sent again within 24 hours, Redis blocks the duplicate in < 1ms:
```json
{
  "status": "error",
  "code": "CONFLICT",
  "message": "DUPLICATE_REQUEST: An event with this Idempotency-Key is already queued or processed",
  "details": {
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
    "project": "billing-invoices"
  }
}
```

---

## Downstream Signature Verification

Every outgoing HTTP request sent by the worker includes:
```
X-Dispatch-Signature: sha256=<hex_digest>
```

Verify it in your destination service using the project's unique `webhookSecret`:

### Node.js (TypeScript / Express)
```typescript
import crypto from 'crypto';

export function verifyWebhookSignature(rawBody: string, signatureHeader: string, webhookSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const received = signatureHeader.replace('sha256=', '');

  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}
```

### Python
```python
import hmac, hashlib

def verify_webhook_signature(raw_body: str, signature_header: str, webhook_secret: str) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    received = signature_header.replace("sha256=", "")
    expected = hmac.new(webhook_secret.encode(), raw_body.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(received, expected)
```

---

## Standard Error Responses

All API errors return standard structured JSON:

```json
{
  "status": "error",
  "code": "BAD_REQUEST",
  "message": "Detailed error message",
  "details": { ... }
}
```

### Common HTTP Status Codes
* **`400 Bad Request`**: Validation failed (e.g. invalid UUID v4, invalid URL, or missing body).
* **`401 Unauthorized`**: Missing or invalid Admin JWT or Project API Key.
* **`404 Not Found`**: Project or DLQ record does not exist.
* **`409 Conflict`**: Duplicate idempotency key detected within 24 hours.
* **`503 Service Unavailable`**: Redis or MongoDB connectivity outage.
