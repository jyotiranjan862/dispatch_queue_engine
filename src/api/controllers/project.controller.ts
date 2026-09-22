import { Request, Response } from 'express';
import { projectService } from '../../services/project.service';
import { dlqService } from '../../services/dlq.service';
import { asyncHandler } from '../../utils/errorHandler';
import ProjectModel from '../../db/models/project.model';

export class ProjectController {
  /**
   * Helper to safely extract single string param from Express Request
   */
  private static getParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0];
    return value || '';
  }

  /**
   * POST /api/projects
   * Registers a new project, auto-generating an API key and HMAC secret.
   */
  public createProject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { name, slug, description } = req.body;
    const project = await projectService.createProject({ name, slug, description });

    res.status(201).json({
      status: 'success',
      data: {
        id: project._id,
        name: project.name,
        slug: project.slug,
        apiKey: project.apiKey,
        webhookSecret: project.webhookSecret,
        description: project.description,
        status: project.status,
        createdAt: project.createdAt,
      },
    });
  });

  /**
   * GET /api/projects
   * Lists all projects with pagination.
   */
  public listProjects = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const status = req.query.status as 'active' | 'archived' | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    const { projects, total } = await projectService.listProjects({ status, limit, skip });

    res.status(200).json({
      status: 'success',
      data: {
        projects: projects.map((p) => ({
          id: p._id,
          name: p.name,
          slug: p.slug,
          apiKey: p.apiKey,
          webhookSecret: p.webhookSecret,
          description: p.description,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        pagination: {
          total,
          limit,
          skip,
        },
      },
    });
  });

  /**
   * GET /api/projects/:id
   * Retrieves single project details and credentials.
   */
  public getProject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = ProjectController.getParam(req.params.id);
    const project = await projectService.getProjectById(id);

    res.status(200).json({
      status: 'success',
      data: {
        id: project._id,
        name: project.name,
        slug: project.slug,
        apiKey: project.apiKey,
        webhookSecret: project.webhookSecret,
        description: project.description,
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    });
  });

  /**
   * PATCH /api/projects/:id
   * Updates project metadata or status.
   */
  public updateProject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = ProjectController.getParam(req.params.id);
    const { name, description, status } = req.body;
    const updated = await projectService.updateProject(id, { name, description, status });

    res.status(200).json({
      status: 'success',
      data: {
        id: updated._id,
        name: updated.name,
        slug: updated.slug,
        status: updated.status,
        description: updated.description,
        updatedAt: updated.updatedAt,
      },
    });
  });

  /**
   * POST /api/projects/:id/rotate-keys
   * Regenerates API key and webhook signing secret.
   */
  public rotateKeys = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = ProjectController.getParam(req.params.id);
    const project = await projectService.rotateCredentials(id);

    res.status(200).json({
      status: 'success',
      message: 'Project credentials successfully rotated',
      data: {
        id: project._id,
        slug: project.slug,
        newApiKey: project.apiKey,
        newWebhookSecret: project.webhookSecret,
      },
    });
  });

  /**
   * DELETE /api/projects/:id
   * Archives a project, preventing any future webhook ingestions.
   */
  public archiveProject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = ProjectController.getParam(req.params.id);
    const project = await projectService.archiveProject(id);

    res.status(200).json({
      status: 'success',
      message: `Project "${project.name}" archived successfully`,
    });
  });

  /**
   * GET /api/projects/:id/dlq
   * Retrieves paginated DLQ records segregated strictly for this project.
   */
  public getProjectDLQ = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectId = ProjectController.getParam(req.params.id);
    // Verify project exists
    await projectService.getProjectById(projectId);

    const status = req.query.status as any;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    const { records, total } = await dlqService.getDLQRecords({
      projectId,
      status,
      limit,
      skip,
    });

    res.status(200).json({
      status: 'success',
      data: {
        records,
        pagination: {
          total,
          limit,
          skip,
        },
      },
    });
  });

  /**
   * GET /api/projects/:id/dlq/stats
   * Retrieves aggregated DLQ metrics for this project.
   */
  public getProjectDLQStats = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectId = ProjectController.getParam(req.params.id);
    await projectService.getProjectById(projectId);

    const stats = await dlqService.getDLQStats(projectId);

    res.status(200).json({
      status: 'success',
      data: stats,
    });
  });

  /**
   * POST /api/projects/:id/dlq/replay/:jobId
   * Replays a single failed DLQ job for this project.
   */
  public replayJob = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectId = ProjectController.getParam(req.params.id);
    const jobId = ProjectController.getParam(req.params.jobId);
    const result = await dlqService.replayJob(projectId, jobId);

    res.status(200).json({
      status: 'success',
      message: `DLQ job "${jobId}" re-enqueued for delivery`,
      data: result,
    });
  });

  /**
   * POST /api/projects/:id/dlq/replay-all
   * Bulk replays all pending/exhausted DLQ jobs for this project.
   */
  public bulkReplay = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectId = ProjectController.getParam(req.params.id);
    const result = await dlqService.bulkReplay(projectId);

    res.status(200).json({
      status: 'success',
      message: `Bulk replay completed. Re-enqueued ${result.replayedCount} dead-letter jobs.`,
      data: result,
    });
  });

  /**
   * GET /api/admin/stats
   * Global aggregated stats for the admin dashboard.
   */
  public getAdminStats = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const [totalProjects, activeProjects, globalDLQStats] = await Promise.all([
      ProjectModel.countDocuments().exec(),
      ProjectModel.countDocuments({ status: 'active' }).exec(),
      dlqService.getDLQStats(),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        projects: {
          total: totalProjects,
          active: activeProjects,
          archived: totalProjects - activeProjects,
        },
        dlq: globalDLQStats,
      },
    });
  });
}

export const projectController = new ProjectController();
export default projectController;
