import { z } from 'zod';

export const createProjectSchema = z.object({
  body: z.object({
    name: z
      .string({ required_error: 'name is required' })
      .trim()
      .min(2, 'Project name must be at least 2 characters')
      .max(100, 'Project name cannot exceed 100 characters'),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]+$/, 'Slug can only contain lowercase alphanumeric characters, dashes, and underscores')
      .max(100)
      .optional(),
    description: z.string().trim().max(500).optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Project ID is required in URL parameter'),
  }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    status: z.enum(['active', 'archived']).optional(),
  }),
});

export const projectParamsSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Project ID is required in URL parameter'),
  }),
});

export const projectDlqParamsSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Project ID is required'),
    jobId: z.string().min(1, 'Job ID is required'),
  }),
});

export const listDlqQuerySchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Project ID is required'),
  }),
  query: z
    .object({
      status: z.enum(['pending', 'replaying', 'replayed', 'exhausted']).optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
      skip: z.coerce.number().min(0).default(0),
    })
    .optional(),
});
