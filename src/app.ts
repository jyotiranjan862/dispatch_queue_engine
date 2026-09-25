import express, { Request, Response } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { checkRedisHealth } from './config/redis';
import { checkDBHealth } from './config/db';
import { securityHeaders, requestLogger, notFoundHandler } from './api/middlewares';
import { errorHandler } from './utils/errorHandler';

import { webhookRouter } from './api/routes/webhook.routes';
import { adminRouter } from './api/routes/admin.routes';
import { projectRouter } from './api/routes/project.routes';

export const app = express();

// Global Middlewares
app.use(securityHeaders);
app.use(
  cors({
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','),
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestLogger);

// Root Info Endpoint with Canonical Endpoints
app.get('/', (req: Request, res: Response) => {
  const host = req.get('host') || `localhost:${env.PORT}`;
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  res.status(200).json({
    name: 'dispatch-queue-engine',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      base: baseUrl,
      health: `${baseUrl}/health`,
      ingest: `${baseUrl}/webhooks/ingest`,
      adminLogin: `${baseUrl}/api/admin/login`,
      projects: `${baseUrl}/api/projects`,
    },
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

// Admin Authentication & Global Stats Routes
app.use('/api/admin', adminRouter);

// Project Registration, Credential Management & DLQ Replay Routes
app.use('/api/projects', projectRouter);

// Webhook Ingestion Routes (Project API Key Enforced)
app.use('/webhooks', webhookRouter);

// 404 Route Not Found Middleware
app.use(notFoundHandler);

// Global Centralized Error Handler
app.use(errorHandler);

export default app;
