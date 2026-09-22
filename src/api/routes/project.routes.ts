import { Router } from 'express';
import { projectController } from '../controllers/project.controller';
import { requireAdminAuth, validateRequest } from '../middlewares';
import {
  createProjectSchema,
  updateProjectSchema,
  projectParamsSchema,
  projectDlqParamsSchema,
  listDlqQuerySchema,
} from '../validators/project.validator';

const router = Router();

// Protect all project management and DLQ control endpoints with Admin Auth
router.use(requireAdminAuth);

/**
 * @route   POST /api/projects
 * @desc    Register a new project and generate credentials
 * @access  Protected (Admin)
 */
router.post('/', validateRequest(createProjectSchema), projectController.createProject);

/**
 * @route   GET /api/projects
 * @desc    List all registered projects with pagination and status filter
 * @access  Protected (Admin)
 */
router.get('/', projectController.listProjects);

/**
 * @route   GET /api/projects/:id
 * @desc    Get project details and credentials
 * @access  Protected (Admin)
 */
router.get('/:id', validateRequest(projectParamsSchema), projectController.getProject);

/**
 * @route   PATCH /api/projects/:id
 * @desc    Update project metadata or status
 * @access  Protected (Admin)
 */
router.patch('/:id', validateRequest(updateProjectSchema), projectController.updateProject);

/**
 * @route   POST /api/projects/:id/rotate-keys
 * @desc    Regenerate API key and webhook secret for project
 * @access  Protected (Admin)
 */
router.post('/:id/rotate-keys', validateRequest(projectParamsSchema), projectController.rotateKeys);

/**
 * @route   DELETE /api/projects/:id
 * @desc    Archive a project (soft delete)
 * @access  Protected (Admin)
 */
router.delete('/:id', validateRequest(projectParamsSchema), projectController.archiveProject);

/**
 * @route   GET /api/projects/:id/dlq
 * @desc    List dead-letter failures for this project
 * @access  Protected (Admin)
 */
router.get('/:id/dlq', validateRequest(listDlqQuerySchema), projectController.getProjectDLQ);

/**
 * @route   GET /api/projects/:id/dlq/stats
 * @desc    Get DLQ statistics breakdown for this project
 * @access  Protected (Admin)
 */
router.get('/:id/dlq/stats', validateRequest(projectParamsSchema), projectController.getProjectDLQStats);

/**
 * @route   POST /api/projects/:id/dlq/replay/:jobId
 * @desc    Replay a specific failed job for this project
 * @access  Protected (Admin)
 */
router.post('/:id/dlq/replay/:jobId', validateRequest(projectDlqParamsSchema), projectController.replayJob);

/**
 * @route   POST /api/projects/:id/dlq/replay-all
 * @desc    Bulk replay all pending/exhausted failed jobs for this project
 * @access  Protected (Admin)
 */
router.post('/:id/dlq/replay-all', validateRequest(projectParamsSchema), projectController.bulkReplay);

export const projectRouter = router;
export default projectRouter;
