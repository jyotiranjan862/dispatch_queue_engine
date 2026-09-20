import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { BadRequestError } from '../../utils/errorHandler';

/**
 * Reusable Express middleware for validating request body, query, and headers with Zod schemas.
 */
export function validateRequest(schema: ZodSchema) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
        headers: req.headers,
      });

      // Replace with sanitized/validated data where applicable
      if (parsed.body) req.body = parsed.body;
      if (parsed.query) req.query = parsed.query;
      if (parsed.params) req.params = parsed.params;

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.slice(1).join('.'),
          message: err.message,
        }));

        next(new BadRequestError('Validation failed for incoming request', details));
      } else {
        next(error);
      }
    }
  };
}

export default validateRequest;
