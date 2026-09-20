import express, { Request, Response } from 'express';
import { checkRedisHealth } from './config/redis';
import { checkDBHealth } from './config/db';
import { securityHeaders, requestLogger, notFoundHandler } from './api/middlewares';
import { errorHandler } from './utils/errorHandler';

export const app = express();

// Global Middlewares
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestLogger);

// Root Info Endpoint
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    name: 'dispatch-queue-engine',
    version: '1.0.0',
    status: 'running',
  });
});

// Health Check Endpoint
app.get('/health', async (_req: Request, res: Response) => {
  const isRedisHealthy = await checkRedisHealth();
  const dbHealth = checkDBHealth();
  const isHealthy = isRedisHealthy && dbHealth.isHealthy;

  const healthData = {
    status: isHealthy ? 'ok' : 'degraded',
    redis: isRedisHealthy ? 'connected' : 'disconnected',
    mongodb: dbHealth.state,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  res.status(isHealthy ? 200 : 503).json(healthData);
});

// 404 Route Not Found Middleware
app.use(notFoundHandler);

// Global Centralized Error Handler
app.use(errorHandler);

export default app;
