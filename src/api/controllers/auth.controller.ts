import { Request, Response } from 'express';
import { authService } from '../../services/auth.service';
import { asyncHandler } from '../../utils/errorHandler';

export class AuthController {
  /**
   * POST /api/admin/login
   * Authenticates admin using ADMIN_TOKEN and returns a signed JWT.
   */
  public login = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { adminToken } = req.body;
    const authResult = authService.loginAdmin(adminToken);

    res.status(200).json({
      status: 'success',
      data: {
        token: authResult.token,
        expiresIn: authResult.expiresIn,
        role: 'admin',
      },
    });
  });

  /**
   * GET /api/admin/me
   * Returns current authenticated admin session context.
   */
  public getMe = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      status: 'success',
      data: {
        admin: req.admin,
      },
    });
  });
}

export const authController = new AuthController();
export default authController;
