import { Request, Response } from 'express';

/**
 * 404 Fallback middleware for unhandled routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
}

export default notFoundHandler;
