import crypto from 'crypto';
import ProjectModel, { IProjectDocument, ProjectStatus } from '../db/models/project.model';
import redis from '../config/redis';
import { ConflictError, NotFoundError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

export interface CachedProject {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  webhookSecret: string;
  status: ProjectStatus;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
}

export class ProjectService {
  private static instance: ProjectService | null = null;
  private readonly cacheTtlSeconds = 600; // 10 minutes cache TTL

  private constructor() {}

  public static getInstance(): ProjectService {
    if (!ProjectService.instance) {
      ProjectService.instance = new ProjectService();
    }
    return ProjectService.instance;
  }

  private getCacheKey(apiKey: string): string {
    return `cache:project:key:${apiKey}`;
  }

  /**
   * Generates a URL-friendly slug from project name.
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Generates a cryptographically strong, prefixed API key.
   */
  private generateApiKey(): string {
    return `dqe_live_${crypto.randomBytes(24).toString('hex')}`;
  }

  /**
   * Generates a 64-character hex webhook signing secret.
   */
  private generateWebhookSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Registers a new project in the system with generated credentials.
   */
  public async createProject(input: CreateProjectInput): Promise<IProjectDocument> {
    const slug = input.slug ? input.slug.toLowerCase().trim() : this.generateSlug(input.name);

    // Check slug collision
    const existing = await ProjectModel.findOne({ slug });
    if (existing) {
      throw new ConflictError(`Project with slug "${slug}" already exists`, { slug });
    }

    const apiKey = this.generateApiKey();
    const webhookSecret = this.generateWebhookSecret();

    const project = await ProjectModel.create({
      name: input.name.trim(),
      slug,
      apiKey,
      webhookSecret,
      description: input.description?.trim() || '',
      status: 'active',
    });

    // Populate Redis cache immediately
    await this.cacheProject(project);

    logger.info('New project registered:', {
      projectId: project._id.toString(),
      name: project.name,
      slug: project.slug,
    });

    return project;
  }

  /**
   * Retrieves active project by API key via Redis cache-aside pattern.
   * Target response time < 2ms via Redis.
   */
  public async getProjectByKey(keyOrSecret: string): Promise<CachedProject | null> {
    if (!keyOrSecret) return null;

    const cacheKey = this.getCacheKey(keyOrSecret);

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as CachedProject;
      }
    } catch (err) {
      logger.warn('Redis cache lookup error in project service:', err);
    }

    // Cache miss: Query MongoDB by apiKey or webhookSecret
    const project = await ProjectModel.findOne({
      $or: [{ apiKey: keyOrSecret }, { webhookSecret: keyOrSecret }],
      status: 'active',
    });
    if (!project) {
      return null;
    }

    const projectData: CachedProject = {
      id: project._id.toString(),
      name: project.name,
      slug: project.slug,
      apiKey: project.apiKey,
      webhookSecret: project.webhookSecret,
      status: project.status,
    };

    try {
      await Promise.all([
        redis.set(this.getCacheKey(project.apiKey), JSON.stringify(projectData), 'EX', this.cacheTtlSeconds),
        redis.set(this.getCacheKey(project.webhookSecret), JSON.stringify(projectData), 'EX', this.cacheTtlSeconds),
      ]);
    } catch (err) {
      logger.warn('Failed to cache project in Redis:', err);
    }

    return projectData;
  }

  /**
   * Helper to write project to Redis cache for both apiKey and webhookSecret.
   */
  private async cacheProject(project: IProjectDocument): Promise<void> {
    try {
      const data: CachedProject = {
        id: project._id.toString(),
        name: project.name,
        slug: project.slug,
        apiKey: project.apiKey,
        webhookSecret: project.webhookSecret,
        status: project.status,
      };
      await Promise.all([
        redis.set(this.getCacheKey(project.apiKey), JSON.stringify(data), 'EX', this.cacheTtlSeconds),
        redis.set(this.getCacheKey(project.webhookSecret), JSON.stringify(data), 'EX', this.cacheTtlSeconds),
      ]);
    } catch (err) {
      logger.warn('Failed to update project cache:', err);
    }
  }

  /**
   * Evicts project credentials from Redis cache.
   */
  private async evictCache(apiKey: string, webhookSecret?: string): Promise<void> {
    try {
      const keysToDelete = [this.getCacheKey(apiKey)];
      if (webhookSecret) {
        keysToDelete.push(this.getCacheKey(webhookSecret));
      }
      await redis.del(...keysToDelete);
    } catch (err) {
      logger.warn('Failed to evict project cache:', err);
    }
  }

  /**
   * Lists registered projects with pagination.
   */
  public async listProjects(options: {
    status?: ProjectStatus;
    limit?: number;
    skip?: number;
  }): Promise<{ projects: IProjectDocument[]; total: number }> {
    const filter: Record<string, unknown> = {};
    if (options.status) {
      filter.status = options.status;
    }

    const limit = Math.min(options.limit || 20, 100);
    const skip = options.skip || 0;

    const [projects, total] = await Promise.all([
      ProjectModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      ProjectModel.countDocuments(filter).exec(),
    ]);

    return { projects, total };
  }

  /**
   * Retrieves single project by ID.
   */
  public async getProjectById(id: string): Promise<IProjectDocument> {
    const project = await ProjectModel.findById(id);
    if (!project) {
      throw new NotFoundError(`Project not found with id "${id}"`);
    }
    return project;
  }

  /**
   * Updates project metadata.
   */
  public async updateProject(
    id: string,
    data: Partial<{ name: string; description: string; status: ProjectStatus }>,
  ): Promise<IProjectDocument> {
    const project = await this.getProjectById(id);

    if (data.name) project.name = data.name.trim();
    if (data.description !== undefined) project.description = data.description.trim();
    if (data.status) {
      project.status = data.status;
      if (data.status === 'archived') {
        await this.evictCache(project.apiKey, project.webhookSecret);
      }
    }

    await project.save();
    if (project.status === 'active') {
      await this.cacheProject(project);
    }

    return project;
  }

  /**
   * Rotates credentials (apiKey and/or webhookSecret) for a project.
   */
  public async rotateCredentials(id: string): Promise<IProjectDocument> {
    const project = await this.getProjectById(id);
    const oldApiKey = project.apiKey;
    const oldWebhookSecret = project.webhookSecret;

    project.apiKey = this.generateApiKey();
    project.webhookSecret = this.generateWebhookSecret();
    await project.save();

    // Evict old keys and cache new keys
    await this.evictCache(oldApiKey, oldWebhookSecret);
    await this.cacheProject(project);

    logger.info('Project credentials rotated:', {
      projectId: project._id.toString(),
      slug: project.slug,
    });

    return project;
  }

  /**
   * Archives a project (soft delete).
   */
  public async archiveProject(id: string): Promise<IProjectDocument> {
    return await this.updateProject(id, { status: 'archived' });
  }
}

export const projectService = ProjectService.getInstance();
export default projectService;
