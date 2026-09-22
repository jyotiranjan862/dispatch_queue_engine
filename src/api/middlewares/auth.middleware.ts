import { Request, Response, NextFunction } from 'express';
import { authService, AdminTokenPayload } from '../../services/auth.service';
import { UnauthorizedError } from '../../utils/errorHandler';

// Extend Express Request interface to include admin payload
declare global {
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload;
    }
  }
}

/**
 * Middleware ensuring incoming requests carry a valid Admin JWT or Bearer token.
 */
export function requireAdminAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const adminHeader = req.headers['x-admin-token'] as string | undefined;

  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (adminHeader) {
    token = adminHeader.trim();
  }

  if (!token) {
    return next(new UnauthorizedError('Admin authentication required. Provide Bearer token or X-Admin-Token'));
  }

  try {
    const admin = authService.verifyToken(token);
    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
}

export default requireAdminAuth;
