import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

export interface AdminTokenPayload {
  sub: string;
  role: 'admin';
  iat?: number;
  exp?: number;
}

export class AuthService {
  private static instance: AuthService | null = null;
  private readonly jwtSecret: string;
  private readonly adminToken: string;

  private constructor() {
    this.jwtSecret = env.JWT_SECRET;
    this.adminToken = env.ADMIN_TOKEN;
  }

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Validates admin credentials and generates a signed JWT token.
   */
  public loginAdmin(adminTokenOrPassword: string): { token: string; expiresIn: string } {
    if (!adminTokenOrPassword || adminTokenOrPassword !== this.adminToken) {
      logger.warn('Failed admin login attempt: invalid admin token');
      throw new UnauthorizedError('Invalid admin credentials');
    }

    const payload: AdminTokenPayload = {
      sub: 'admin',
      role: 'admin',
    };

    const token = jwt.sign(payload, this.jwtSecret, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    logger.info('Admin authenticated successfully, JWT issued');

    return {
      token,
      expiresIn: env.JWT_EXPIRES_IN,
    };
  }

  /**
   * Verifies a JWT token or direct Bearer admin token string.
   */
  public verifyToken(token: string): AdminTokenPayload {
    if (!token) {
      throw new UnauthorizedError('Authentication token missing');
    }

    // Direct match with ADMIN_TOKEN allowed for system/CLI operations
    if (token === this.adminToken) {
      return { sub: 'admin', role: 'admin' };
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret) as AdminTokenPayload;
      if (decoded.role !== 'admin') {
        throw new UnauthorizedError('Insufficient privileges');
      }
      return decoded;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Admin session token has expired');
      }
      throw new UnauthorizedError('Invalid admin session token');
    }
  }
}

export const authService = AuthService.getInstance();
export default authService;
