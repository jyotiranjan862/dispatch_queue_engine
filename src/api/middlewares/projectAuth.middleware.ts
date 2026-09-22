import { Request, Response, NextFunction } from 'express';
import { projectService, CachedProject } from '../../services/project.service';
import { UnauthorizedError, ForbiddenError } from '../../utils/errorHandler';

declare global {
  namespace Express {
    interface Request {
      project?: CachedProject;
    }
  }
}

/**
 * Middleware that guarantees every incoming webhook belongs to a valid, active registered project.
 * Prevents orphan requests and enforces project isolation.
 */
export async function validateProjectKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const projectKey = (
    req.headers['x-project-key'] ||
    req.headers['x-api-key'] ||
    req.headers['x-project-secret'] ||
    req.headers['x-webhook-secret']
  ) as string | undefined;

  if (!projectKey || typeof projectKey !== 'string' || projectKey.trim().length === 0) {
    return next(
      new UnauthorizedError(
        'Project authentication required. Provide X-Project-Key, X-API-Key, or X-Webhook-Secret header to ingest webhooks',
      ),
    );
  }

  try {
    const project = await projectService.getProjectByKey(projectKey.trim());

    if (!project) {
      return next(new UnauthorizedError('Invalid project key or project does not exist'));
    }

    if (project.status !== 'active') {
      return next(new ForbiddenError(`Project "${project.slug}" is archived and cannot ingest webhooks`));
    }

    req.project = project;
    next();
  } catch (err) {
    next(err);
  }
}

export default validateProjectKey;
