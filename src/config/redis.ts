import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';

/**
 * Standard Redis connection options.
 * BullMQ requires `maxRetriesPerRequest: null` to avoid rejecting commands while reconnecting.
 */
export const redisConfig: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME || undefined,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy(times: number) {
    const maxRetryDelay = 2000;
    const delay = Math.min(times * 50, maxRetryDelay);
    return delay;
  },
};

/**
 * Singleton Redis client instance for general cache, locks, and idempotency checks.
 */
class RedisClientSingleton {
  private static instance: Redis | null = null;

  private constructor() {}

  public static getInstance(): Redis {
    if (!RedisClientSingleton.instance) {
      const connectionUrl = env.REDIS_URL;
      RedisClientSingleton.instance = connectionUrl
        ? new Redis(connectionUrl, { maxRetriesPerRequest: null, lazyConnect: true })
        : new Redis(redisConfig);

      RedisClientSingleton.instance.on('connect', () => {
        console.log('[Redis] Connection established');
      });

      RedisClientSingleton.instance.on('ready', () => {
        console.log('[Redis] Ready to accept commands');
      });

      RedisClientSingleton.instance.on('error', (err: Error) => {
        console.error('[Redis] Error encountered:', err.message);
      });

      RedisClientSingleton.instance.on('close', () => {
        console.warn('[Redis] Connection closed');
      });

      RedisClientSingleton.instance.on('reconnecting', (time: number) => {
        console.log(`[Redis] Reconnecting in ${time}ms`);
      });
    }

    return RedisClientSingleton.instance;
  }
}

export const redis = RedisClientSingleton.getInstance();

/**
 * Connect to Redis if not already connected.
 */
export async function connectRedis(): Promise<Redis> {
  if (redis.status === 'wait' || redis.status === 'close') {
    await redis.connect();
  }
  return redis;
}

/**
 * Gracefully close the Redis client connection.
 */
export async function disconnectRedis(): Promise<void> {
  if (redis.status !== 'end' && redis.status !== 'close') {
    await redis.quit();
    console.log('[Redis] Connection cleanly terminated');
  }
}

/**
 * Health check utility to ping Redis.
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err) {
    console.error('[Redis] Health check failed:', err);
    return false;
  }
}

export default redis;
