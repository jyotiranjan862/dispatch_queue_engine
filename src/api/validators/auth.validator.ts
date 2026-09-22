import { z } from 'zod';

export const adminLoginSchema = z.object({
  body: z.object({
    adminToken: z.string({
      required_error: 'adminToken is required for admin authentication',
    }).min(1, 'adminToken cannot be empty'),
  }),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
