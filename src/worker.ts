import { Worker, Job } from 'bullmq';
import { connectDB, disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { QUEUE_NAME, createQueueConnection, defaultWorkerOptions } from './config/queue';
import { logger } from './utils/logger';

let worker: Worker | null = null;
let isShuttingDown = false;

/**
 * Job processing handler.
 * Dispatches the webhook payload to the target URL with cryptographic signature.
 */
async function processWebhookJob(job: Job): Promise<{ success: boolean; status: number }> {
  logger.info(`[Worker] Processing job ${job.id} (Attempt ${job.attemptsMade + 1})`, {
    targetUrl: job.data.target_url,
    idempotencyKey: job.data.idempotency_key,
  });

  // Placeholder logic for the actual dispatch worker processor
  // Will be wired to dispatch service / axios client
  return { success: true, status: 200 };
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
    logger.info('[Worker] Starting worker process...');

    await connectDB();
    await connectRedis();

    const connection = createQueueConnection();

    worker = new Worker(QUEUE_NAME, processWebhookJob, {
      ...defaultWorkerOptions,
      connection,
    });

    worker.on('ready', () => {
      logger.info(`[Worker] Worker listening for jobs on queue: "${QUEUE_NAME}"`);
    });

    worker.on('completed', (job: Job, result: unknown) => {
      logger.info(`[Worker] Job ${job.id} completed successfully`, { result });
    });

    worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error(`[Worker] Job ${job?.id} failed`, {
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    worker.on('error', (err: Error) => {
      logger.error('[Worker] Worker instance error:', err);
    });

    process.on('SIGTERM', () => shutdownWorker('SIGTERM'));
    process.on('SIGINT', () => shutdownWorker('SIGINT'));
  } catch (error) {
    logger.error('[Worker] Failed to start worker process:', error);
    process.exit(1);
  }
}

startWorker();
