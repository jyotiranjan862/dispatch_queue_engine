import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

/**
 * Request logging middleware tracking incoming HTTP methods, URLs, status codes, and durations.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });

  next();
}

export default requestLogger;
