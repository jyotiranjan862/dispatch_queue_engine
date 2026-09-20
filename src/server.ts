import http from 'http';
import { env } from './config/env';
import { app } from './app';
import { connectDB, disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { logger } from './utils/logger';

const PORT = env.PORT;

let server: http.Server | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown sequence:
 * 1. Stop receiving new HTTP requests.
 * 2. Close Redis client connections.
 * 3. Close MongoDB connections.
 * 4. Exit cleanly or timeout after 10s.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timeout reached (10s). Forcing process exit.');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  if (server) {
    server.close(async (err) => {
      if (err) {
        logger.error('Error closing HTTP server:', err);
      } else {
        logger.info('HTTP server closed successfully.');
      }

      try {
        await disconnectRedis();
        await disconnectDB();
        logger.info('Database and Cache connections closed. Shutdown complete.');
        process.exit(0);
      } catch (shutdownErr) {
        logger.error('Error during cleanup teardown:', shutdownErr);
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

/**
 * Bootstrap function to initialize dependencies and start HTTP listener.
 */
async function startServer(): Promise<void> {
  try {
    logger.info('Initializing database and cache connections...');

    // Connect to MongoDB
    await connectDB();

    // Connect to Redis
    await connectRedis();

    // Start Express server
    server = app.listen(PORT, () => {
      logger.info(`Server running in ${env.NODE_ENV} mode on port ${PORT}`);
      logger.info(`Health check available at http://localhost:${PORT}/health`);
    });

    // Handle process termination signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason: unknown) => {
      logger.error('Unhandled Promise Rejection:', reason);
    });

    process.on('uncaughtException', (error: Error) => {
      logger.error('Uncaught Exception thrown:', error);
      gracefulShutdown('uncaughtException');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
