import { z } from 'zod';

export const ingestWebhookSchema = z.object({
  headers: z
    .object({
      'idempotency-key': z
        .string({
          required_error: 'Idempotency-Key header is required',
        })
        .uuid('Idempotency-Key must be a valid UUID v4')
        .max(128, 'Idempotency-Key cannot exceed 128 characters'),
    })
    .passthrough(), // Allow other standard HTTP headers (Content-Type, User-Agent, etc.)
  body: z.object({
    target_url: z
      .string({
        required_error: 'target_url is required',
      })
      .url('target_url must be a valid HTTP or HTTPS URL'),
    payload: z
      .record(z.string(), z.unknown(), {
        required_error: 'payload must be a valid JSON object',
      })
      .refine((obj) => Object.keys(obj).length > 0, {
        message: 'payload object cannot be empty',
      }),
  }),
});

export type IngestWebhookInput = z.infer<typeof ingestWebhookSchema>;
