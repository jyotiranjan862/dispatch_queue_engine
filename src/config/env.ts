import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),
  REDIS_URL: z.string().optional(),

  // MongoDB
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/dispatch_engine'),
  MONGO_MAX_POOL_SIZE: z.coerce.number().default(10),
  MONGO_MIN_POOL_SIZE: z.coerce.number().default(2),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().default(5000),

  // Security
  WEBHOOK_SECRET: z
    .string()
    .min(16, 'WEBHOOK_SECRET must be at least 16 characters long for HMAC security')
    .default('development_webhook_secret_key_32_characters_long_for_hmac'),
  ADMIN_TOKEN: z.string().min(1).default('dev_admin_bearer_token_12345'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters long')
    .default('super_secret_jwt_admin_key_32_characters_long'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  CORS_ORIGIN: z.string().default('*'),

  // BullMQ & Jobs
  QUEUE_NAME: z.string().default('webhook-dispatch'),
  MAX_RETRIES: z.coerce.number().default(5),
  JOB_TIMEOUT_MS: z.coerce.number().default(10000),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().default(86400),
  WORKER_CONCURRENCY: z.coerce.number().default(5),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).optional(),
});

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables detected:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }

  return result.data;
};

export const env = parseEnv();

export type EnvConfig = z.infer<typeof envSchema>;

export default env;
