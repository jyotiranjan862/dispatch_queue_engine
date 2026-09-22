import { Router } from 'express';
import { validateRequest, validateProjectKey } from '../middlewares';
import { ingestWebhookSchema } from '../validators/webhook.validator';
import { webhookController } from '../controllers/webhook.controller';

const router = Router();

/**
 * @route   POST /webhooks/ingest
 * @desc    Ingest a webhook for guaranteed, idempotent asynchronous delivery
 * @access  Protected (Requires active Project Key via X-Project-Key or X-API-Key)
 */
router.post(
  '/ingest',
  validateProjectKey,
  validateRequest(ingestWebhookSchema),
  webhookController.ingest,
);

export const webhookRouter = router;
export default webhookRouter;
