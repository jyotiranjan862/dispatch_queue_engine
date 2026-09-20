import { Worker, Job } from 'bullmq';
import { connectDB, disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { QUEUE_NAME, createQueueConnection, defaultWorkerOptions } from './config/queue';
import { env } from './config/env';
import { WebhookJobData } from './services/queue.service';
import { dispatchService, DispatchResult } from './services/dispatch.service';
import { dlqService } from './services/dlq.service';
import { idempotencyService } from './services/idempotency.service';
import { logger } from './utils/logger';

let worker: Worker<WebhookJobData> | null = null;
let isShuttingDown = false;

/**
 * Job processing handler.
 * Dispatches the webhook payload to the target URL with cryptographic signature.
 */
async function processWebhookJob(job: Job<WebhookJobData>): Promise<DispatchResult> {
  const attempt = job.attemptsMade + 1;
  logger.info(
    `[Worker] Processing job ${job.id} (Attempt ${attempt}/${job.opts.attempts || env.MAX_RETRIES})`,
    {
      targetUrl: job.data.target_url,
      idempotencyKey: job.data.idempotency_key,
    },
  );

  // Mark status in Redis as currently processing
  await idempotencyService.updateStatus(job.data.idempotency_key, 'processing');

  // Perform the HTTP dispatch with timeout, connection pooling, and HMAC signing
  return await dispatchService.dispatchWebhook(
    job.data.target_url,
    job.data.payload,
    job.data.idempotency_key,
    attempt,
  );
}

/**
 * Graceful shutdown handler for Worker process.
 */
async function shutdownWorker(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info(`[Worker] Received ${signal}. Initiating graceful worker shutdown...`);

  const forceTimeout = setTimeout(() => {
    logger.error('[Worker] Shutdown timed out (10s). Forcing termination.');
    process.exit(1);
  }, 10000);
  forceTimeout.unref();

  try {
    if (worker) {
      await worker.close();
      logger.info('[Worker] BullMQ worker paused and closed.');
    }
    await disconnectRedis();
    await disconnectDB();
    logger.info('[Worker] Worker cleanup complete. Exiting.');
    process.exit(0);
  } catch (err) {
    logger.error('[Worker] Error during worker teardown:', err);
    process.exit(1);
  }
}

/**
 * Bootstrap the worker process.
 */
async function startWorker(): Promise<void> {
  try {
    logger.info('[Worker] Initializing database and cache connections...');

    await connectDB();
    await connectRedis();

    const connection = createQueueConnection();

    worker = new Worker<WebhookJobData>(QUEUE_NAME, processWebhookJob, {
      ...defaultWorkerOptions,
      connection,
    });

    worker.on('ready', () => {
      logger.info(`[Worker] Worker listening for jobs on queue: "${QUEUE_NAME}"`);
    });

    worker.on('completed', async (job: Job<WebhookJobData>, result: DispatchResult) => {
      logger.info(`[Worker] Job ${job.id} completed successfully (HTTP ${result.statusCode})`);
      await idempotencyService.updateStatus(job.data.idempotency_key, 'delivered');
    });

    worker.on('failed', async (job: Job<WebhookJobData> | undefined, err: Error) => {
      if (!job) {
        logger.error('[Worker] Unhandled failure on missing job:', err);
        return;
      }

      const maxAttempts = job.opts.attempts || env.MAX_RETRIES;
      const isExhausted = job.attemptsMade >= maxAttempts || err.name === 'UnrecoverableError';

      logger.warn(
        `[Worker] Job ${job.id} failed (Attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`,
      );

      // If all retry attempts failed or error is unrecoverable (e.g. 4xx), move to DLQ
      if (isExhausted) {
        try {
          await dlqService.saveToDLQ(job.data, err, job.attemptsMade);
        } catch (dlqErr) {
          logger.error('[Worker] Failed to write exhausted job to DLQ:', dlqErr);
        }
      }
    });

    worker.on('error', (err: Error) => {
      logger.error('[Worker] Worker runtime error:', err);
    });

    process.on('SIGTERM', () => shutdownWorker('SIGTERM'));
    process.on('SIGINT', () => shutdownWorker('SIGINT'));
  } catch (error) {
    logger.error('[Worker] Failed to start worker process:', error);
    process.exit(1);
  }
}

startWorker();
