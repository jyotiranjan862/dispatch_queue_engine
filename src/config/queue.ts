import Redis from 'ioredis';
import { DefaultJobOptions, WorkerOptions } from 'bullmq';
import { env } from './env';
import { redisConfig } from './redis';

/**
 * Queue name configured via environment.
 */
export const QUEUE_NAME = env.QUEUE_NAME;

/**
 * Creates an isolated Redis connection instance for BullMQ components (Queue, Worker, QueueEvents).
 * BullMQ requires distinct connections to avoid blocking commands clashing across clients.
 */
export function createQueueConnection(): Redis {
  return env.REDIS_URL
    ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true })
    : new Redis(redisConfig);
}

/**
 * Default BullMQ job options enforcing idempotency, exponential backoff, and memory bounds.
 */
export const defaultJobOptions: DefaultJobOptions = {
  attempts: env.MAX_RETRIES,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: {
    count: 1000,
    age: 86400, // 24 hours retention
  },
  removeOnFail: false, // Keep failed jobs for Dead-Letter Queue persistence
};

/**
 * Configuration options for BullMQ Worker processing.
 */
export const defaultWorkerOptions: Omit<WorkerOptions, 'connection'> = {
  concurrency: env.WORKER_CONCURRENCY,
  lockDuration: 30000, // 30s lock
  lockRenewTime: 15000,
};
