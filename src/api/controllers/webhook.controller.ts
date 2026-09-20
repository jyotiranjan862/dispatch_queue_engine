import { Request, Response } from 'express';
import { idempotencyService } from '../../services/idempotency.service';
import { queueService } from '../../services/queue.service';
import { ConflictError, asyncHandler } from '../../utils/errorHandler';

export class WebhookController {
  /**
   * POST /webhooks/ingest
   * Ingests a webhook event idempotently and enqueues for async delivery.
   */
  public ingest = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const idempotencyKey = req.headers['idempotency-key'] as string;
    const { target_url, payload } = req.body;

    // 1. Atomic Redis check (< 1ms). If key exists, reject duplicate immediately.
    const isNewEvent = await idempotencyService.acquireLock(idempotencyKey);
    if (!isNewEvent) {
      throw new ConflictError(
        'DUPLICATE_REQUEST: An event with this Idempotency-Key is already queued or processed',
        { idempotency_key: idempotencyKey },
      );
    }

    // 2. Enqueue job into BullMQ
    try {
      const jobId = await queueService.addWebhookJob({
        idempotency_key: idempotencyKey,
        target_url,
        payload,
        enqueued_at: new Date().toISOString(),
      });

      // 3. Immediately respond with 202 Accepted (< 20ms)
      res.status(202).json({
        job_id: jobId,
        status: 'queued',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // 4. Rollback Redis lock so the client can safely retry without 24h block
      await idempotencyService.releaseLock(idempotencyKey);
      throw error;
    }
  });
}

export const webhookController = new WebhookController();
export default webhookController;
