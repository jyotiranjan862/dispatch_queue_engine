import redis from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export class IdempotencyService {
  private static instance: IdempotencyService | null = null;

  private constructor() {}

  public static getInstance(): IdempotencyService {
    if (!IdempotencyService.instance) {
      IdempotencyService.instance = new IdempotencyService();
    }
    return IdempotencyService.instance;
  }

  /**
   * Atomically acquires an idempotency lock for the given key.
   * Uses Redis SET with NX and EX to guarantee atomicity and race-condition safety.
   *
   * @param idempotencyKey - The unique event identifier (UUID v4)
   * @returns true if lock was acquired (new event), false if key already exists (duplicate)
   */
  public async acquireLock(idempotencyKey: string): Promise<boolean> {
    const key = `idempotency:${idempotencyKey}`;
    try {
      const result = await redis.set(key, 'queued', 'EX', env.IDEMPOTENCY_TTL_SECONDS, 'NX');
      return result === 'OK';
    } catch (error) {
      logger.error('Failed to acquire idempotency lock in Redis:', {
        key: idempotencyKey,
        error,
      });
      throw error;
    }
  }

  /**
   * Releases an idempotency lock. Used as a rollback mechanism if job enqueuing fails,
   * allowing the client to safely retry without being blocked for 24 hours.
   */
  public async releaseLock(idempotencyKey: string): Promise<void> {
    const key = `idempotency:${idempotencyKey}`;
    try {
      await redis.del(key);
      logger.warn('Released idempotency lock following downstream failure:', {
        key: idempotencyKey,
      });
    } catch (error) {
      logger.error('Failed to release idempotency lock in Redis:', {
        key: idempotencyKey,
        error,
      });
    }
  }

  /**
   * Updates the status of an idempotency key (e.g., 'processing', 'completed', 'failed').
   */
  public async updateStatus(idempotencyKey: string, status: string): Promise<void> {
    const key = `idempotency:${idempotencyKey}`;
    try {
      const ttl = await redis.ttl(key);
      if (ttl > 0) {
        await redis.set(key, status, 'EX', ttl);
      }
    } catch (error) {
      logger.error('Failed to update idempotency status in Redis:', {
        key: idempotencyKey,
        status,
        error,
      });
    }
  }

  /**
   * Checks current idempotency status for an event key.
   */
  public async getStatus(idempotencyKey: string): Promise<string | null> {
    const key = `idempotency:${idempotencyKey}`;
    return await redis.get(key);
  }
}

export const idempotencyService = IdempotencyService.getInstance();
export default idempotencyService;
