import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validateRequest, requireAdminAuth } from '../middlewares';
import { adminLoginSchema } from '../validators/auth.validator';

const router = Router();

/**
 * @route   POST /api/admin/login
 * @desc    Authenticate admin and acquire JWT session token
 * @access  Public
 */
router.post('/login', validateRequest(adminLoginSchema), authController.login);

/**
 * @route   GET /api/admin/me
 * @desc    Verify active admin session
 * @access  Protected (Admin only)
 */
router.get('/me', requireAdminAuth, authController.getMe);

export const authRouter = router;
export default authRouter;
