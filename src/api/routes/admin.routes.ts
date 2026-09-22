import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { projectController } from '../controllers/project.controller';
import { validateRequest, requireAdminAuth } from '../middlewares';
import { adminLoginSchema } from '../validators/auth.validator';

const router = Router();

/**
 * @route   POST /api/admin/login
 * @desc    Admin login endpoint returning signed JWT
 * @access  Public
 */
router.post('/login', validateRequest(adminLoginSchema), authController.login);

/**
 * @route   GET /api/admin/me
 * @desc    Get currently logged in admin context
 * @access  Protected (Admin)
 */
router.get('/me', requireAdminAuth, authController.getMe);

/**
 * @route   GET /api/admin/stats
 * @desc    Global overview analytics (projects count, DLQ stats)
 * @access  Protected (Admin)
 */
router.get('/stats', requireAdminAuth, projectController.getAdminStats);

export const adminRouter = router;
export default adminRouter;
