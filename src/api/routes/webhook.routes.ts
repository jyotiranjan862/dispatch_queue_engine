import { Router } from 'express';
import { validateRequest } from '../middlewares';
import { ingestWebhookSchema } from '../validators/webhook.validator';
import { webhookController } from '../controllers/webhook.controller';

const router = Router();

/**
 * @route   POST /webhooks/ingest
 * @desc    Ingest a webhook for guaranteed, idempotent asynchronous delivery
 * @access  Public (Ingestion)
 */
router.post('/ingest', validateRequest(ingestWebhookSchema), webhookController.ingest);

export const webhookRouter = router;
export default webhookRouter;
