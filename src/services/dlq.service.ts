import DLQModel, { IDLQDocument, DLQStatus } from '../db/models/dlq.model';
import { WebhookJobData } from './queue.service';
import { idempotencyService } from './idempotency.service';
import { logger } from '../utils/logger';

export class DLQService {
  private static instance: DLQService | null = null;

  private constructor() {}

  public static getInstance(): DLQService {
    if (!DLQService.instance) {
      DLQService.instance = new DLQService();
    }
    return DLQService.instance;
  }

  /**
   * Persists an exhausted or unrecoverable failed webhook job to MongoDB.
   *
   * @param jobData - The original webhook data from BullMQ
   * @param error - The final failure error
   * @param attemptsMade - Total number of attempts executed before exhaustion
   */
  public async saveToDLQ(
    jobData: WebhookJobData,
    error: Error,
    attemptsMade: number,
  ): Promise<IDLQDocument> {
    try {
      const dlqRecord = await DLQModel.findOneAndUpdate(
        { jobId: jobData.idempotency_key },
        {
          jobId: jobData.idempotency_key,
          idempotencyKey: jobData.idempotency_key,
          targetUrl: jobData.target_url,
          payload: jobData.payload,
          attemptsMade,
          lastError: {
            message: error.message,
            stack: error.stack,
            timestamp: new Date(),
          },
          status: 'pending',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Update Redis status to reflect final exhaustion
      await idempotencyService.updateStatus(jobData.idempotency_key, 'exhausted');

      logger.warn('Job stored in Dead-Letter Queue (MongoDB):', {
        jobId: jobData.idempotency_key,
        targetUrl: jobData.target_url,
        attemptsMade,
        error: error.message,
      });

      return dlqRecord;
    } catch (err) {
      logger.error('CRITICAL: Failed to write exhausted job to MongoDB DLQ:', {
        jobId: jobData.idempotency_key,
        error: err,
      });
      throw err;
    }
  }

  /**
   * Fetches paginated records from the DLQ collection.
   */
  public async getDLQRecords(options: {
    status?: DLQStatus;
    limit?: number;
    skip?: number;
  }): Promise<{ records: IDLQDocument[]; total: number }> {
    const filter = options.status ? { status: options.status } : {};
    const limit = Math.min(options.limit || 50, 100);
    const skip = options.skip || 0;

    const [records, total] = await Promise.all([
      DLQModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      DLQModel.countDocuments(filter).exec(),
    ]);

    return { records, total };
  }

  /**
   * Marks a DLQ job as replayed.
   */
  public async markAsReplayed(jobId: string, replayedJobId: string): Promise<void> {
    await DLQModel.updateOne(
      { jobId },
      {
        status: 'replayed',
        replayedAt: new Date(),
        replayedJobId,
      },
    );
  }
}

export const dlqService = DLQService.getInstance();
export default dlqService;
