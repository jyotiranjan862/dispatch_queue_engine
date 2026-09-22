import { Request, Response } from 'express';
import { idempotencyService } from '../../services/idempotency.service';
import { queueService } from '../../services/queue.service';
import { ConflictError, asyncHandler, UnauthorizedError } from '../../utils/errorHandler';

export class WebhookController {
  /**
   * POST /webhooks/ingest
   * Ingests a webhook event idempotently and enqueues for async delivery under a registered project.
   */
  public ingest = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const idempotencyKey = req.headers['idempotency-key'] as string;
    const { target_url, payload } = req.body;
    const project = req.project;

    if (!project) {
      throw new UnauthorizedError('Request missing verified project association');
    }

    // 1. Atomic Redis check (< 1ms). If key exists, reject duplicate immediately.
    const isNewEvent = await idempotencyService.acquireLock(idempotencyKey);
    if (!isNewEvent) {
      throw new ConflictError(
        'DUPLICATE_REQUEST: An event with this Idempotency-Key is already queued or processed',
        { idempotency_key: idempotencyKey, project: project.slug },
      );
    }

    // 2. Enqueue job into BullMQ tagged with project metadata and per-project secret
    try {
      const jobId = await queueService.addWebhookJob({
        projectId: project.id,
        projectSlug: project.slug,
        webhookSecret: project.webhookSecret,
        idempotency_key: idempotencyKey,
        target_url,
        payload,
        enqueued_at: new Date().toISOString(),
      });

      // 3. Immediately respond with 202 Accepted (< 20ms)
      res.status(202).json({
        job_id: jobId,
        project: {
          id: project.id,
          slug: project.slug,
        },
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
