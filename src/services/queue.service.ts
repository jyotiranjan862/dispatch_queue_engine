import { Queue, Job } from 'bullmq';
import { QUEUE_NAME, createQueueConnection, defaultJobOptions } from '../config/queue';
import { logger } from '../utils/logger';

export interface WebhookJobData {
  projectId: string;
  projectSlug: string;
  webhookSecret: string;
  idempotency_key: string;
  target_url: string;
  payload: Record<string, unknown>;
  enqueued_at: string;
}

export class QueueService {
  private static instance: QueueService | null = null;
  private queue: Queue<WebhookJobData>;

  private constructor() {
    this.queue = new Queue<WebhookJobData>(QUEUE_NAME, {
      connection: createQueueConnection(),
      defaultJobOptions,
    });

    this.queue.on('error', (err: Error) => {
      logger.error('BullMQ Queue encountered error:', err);
    });
  }

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  /**
   * Enqueues a webhook dispatch job into BullMQ.
   *
   * @param data - Webhook payload, target URL, and idempotency key
   * @returns The BullMQ job ID
   */
  public async addWebhookJob(data: WebhookJobData): Promise<string> {
    try {
      const job = await this.queue.add('dispatch-job', data, {
        jobId: data.idempotency_key, // Re-enforces uniqueness at queue level
      });

      logger.info('Webhook job enqueued successfully:', {
        jobId: job.id,
        targetUrl: data.target_url,
        idempotencyKey: data.idempotency_key,
      });

      return job.id!;
    } catch (error) {
      logger.error('Failed to add job to BullMQ queue:', {
        idempotencyKey: data.idempotency_key,
        error,
      });
      throw error;
    }
  }

  /**
   * Retrieves a job by its ID.
   */
  public async getJob(jobId: string): Promise<Job<WebhookJobData> | undefined> {
    return await this.queue.getJob(jobId);
  }

  /**
   * Gracefully close the BullMQ queue connection.
   */
  public async close(): Promise<void> {
    await this.queue.close();
    logger.info('BullMQ Queue closed cleanly');
  }
}

export const queueService = QueueService.getInstance();
export default queueService;
