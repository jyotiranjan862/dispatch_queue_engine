import { Types } from 'mongoose';
import DLQModel, { IDLQDocument, DLQStatus } from '../db/models/dlq.model';
import { queueService, WebhookJobData } from './queue.service';
import { idempotencyService } from './idempotency.service';
import { logger } from '../utils/logger';
import { NotFoundError, BadRequestError } from '../utils/errorHandler';
import ProjectModel from '../db/models/project.model';

export interface DLQQueryOptions {
  projectId?: string;
  projectSlug?: string;
  status?: DLQStatus;
  limit?: number;
  skip?: number;
}

export interface DLQStats {
  pending: number;
  replaying: number;
  replayed: number;
  exhausted: number;
  total: number;
}

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
          projectId: new Types.ObjectId(jobData.projectId),
          projectSlug: jobData.projectSlug,
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
        projectId: jobData.projectId,
        projectSlug: jobData.projectSlug,
        jobId: jobData.idempotency_key,
        targetUrl: jobData.target_url,
        attemptsMade,
        error: error.message,
      });

      return dlqRecord;
    } catch (err) {
      logger.error('CRITICAL: Failed to write exhausted job to MongoDB DLQ:', {
        projectId: jobData.projectId,
        jobId: jobData.idempotency_key,
        error: err,
      });
      throw err;
    }
  }

  /**
   * Fetches paginated records from the DLQ collection with optional project filtering.
   */
  public async getDLQRecords(options: DLQQueryOptions): Promise<{ records: IDLQDocument[]; total: number }> {
    const filter: Record<string, unknown> = {};

    if (options.projectId) {
      filter.projectId = new Types.ObjectId(options.projectId);
    } else if (options.projectSlug) {
      filter.projectSlug = options.projectSlug;
    }

    if (options.status) {
      filter.status = options.status;
    }

    const limit = Math.min(options.limit || 50, 100);
    const skip = options.skip || 0;

    const [records, total] = await Promise.all([
      DLQModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      DLQModel.countDocuments(filter).exec(),
    ]);

    return { records, total };
  }

  /**
   * Retrieves aggregated DLQ status statistics for a specific project or globally.
   */
  public async getDLQStats(projectId?: string): Promise<DLQStats> {
    const matchFilter: Record<string, unknown> = {};
    if (projectId) {
      matchFilter.projectId = new Types.ObjectId(projectId);
    }

    const counts = await DLQModel.aggregate([
      { $match: matchFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const stats: DLQStats = {
      pending: 0,
      replaying: 0,
      replayed: 0,
      exhausted: 0,
      total: 0,
    };

    for (const item of counts) {
      if (item._id in stats) {
        stats[item._id as keyof DLQStats] = item.count;
      }
      stats.total += item.count;
    }

    return stats;
  }

  /**
   * Replays a single failed DLQ job strictly within the project scope.
   */
  public async replayJob(projectId: string, jobId: string): Promise<{ replayedJobId: string }> {
    const record = await DLQModel.findOne({
      jobId,
      projectId: new Types.ObjectId(projectId),
    });

    if (!record) {
      throw new NotFoundError(`DLQ record not found with jobId "${jobId}" for this project`);
    }

    if (record.status === 'replayed') {
      throw new BadRequestError(`Job "${jobId}" has already been replayed`);
    }

    // Look up project details to get latest webhook secret
    const project = await ProjectModel.findById(projectId);
    if (!project || project.status !== 'active') {
      throw new BadRequestError('Cannot replay job: Associated project is inactive or archived');
    }

    const newJobId = `replay_${jobId}_${Date.now()}`;

    // Mark as replaying
    record.status = 'replaying';
    await record.save();

    // Re-enqueue into BullMQ
    await queueService.addWebhookJob({
      projectId: project._id.toString(),
      projectSlug: project.slug,
      webhookSecret: project.webhookSecret,
      idempotency_key: newJobId,
      target_url: record.targetUrl,
      payload: record.payload,
      enqueued_at: new Date().toISOString(),
    });

    record.status = 'replayed';
    record.replayedAt = new Date();
    record.replayedJobId = newJobId;
    await record.save();

    logger.info('DLQ job replayed successfully:', {
      projectId,
      originalJobId: jobId,
      replayedJobId: newJobId,
    });

    return { replayedJobId: newJobId };
  }

  /**
   * Bulk replays all pending/exhausted DLQ jobs for a specific project.
   */
  public async bulkReplay(projectId: string): Promise<{ replayedCount: number }> {
    const project = await ProjectModel.findById(projectId);
    if (!project || project.status !== 'active') {
      throw new BadRequestError('Cannot bulk replay: Associated project is inactive or archived');
    }

    const eligibleRecords = await DLQModel.find({
      projectId: new Types.ObjectId(projectId),
      status: { $in: ['pending', 'exhausted'] },
    }).limit(100); // Guard max 100 per bulk batch to prevent burst flooding

    let replayedCount = 0;

    for (const record of eligibleRecords) {
      try {
        const newJobId = `replay_${record.jobId}_${Date.now()}`;
        await queueService.addWebhookJob({
          projectId: project._id.toString(),
          projectSlug: project.slug,
          webhookSecret: project.webhookSecret,
          idempotency_key: newJobId,
          target_url: record.targetUrl,
          payload: record.payload,
          enqueued_at: new Date().toISOString(),
        });

        record.status = 'replayed';
        record.replayedAt = new Date();
        record.replayedJobId = newJobId;
        await record.save();
        replayedCount++;
      } catch (err) {
        logger.error(`Failed to replay DLQ job ${record.jobId}:`, err);
      }
    }

    logger.info('Bulk DLQ replay completed:', { projectId, replayedCount });
    return { replayedCount };
  }
}

export const dlqService = DLQService.getInstance();
export default dlqService;
