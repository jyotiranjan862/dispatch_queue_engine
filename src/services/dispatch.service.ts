import http from 'http';
import https from 'https';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { env } from '../config/env';
import { signerService } from './signer.service';
import { logger } from '../utils/logger';

export interface DispatchResult {
  statusCode: number;
  durationMs: number;
  responseBody?: unknown;
}

export class DispatchService {
  private static instance: DispatchService | null = null;
  private client: AxiosInstance;

  private constructor() {
    // Reusable HTTP and HTTPS agents with keep-alive connection pooling
    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 10,
      timeout: env.JOB_TIMEOUT_MS,
    });

    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 10,
      timeout: env.JOB_TIMEOUT_MS,
    });

    this.client = axios.create({
      timeout: env.JOB_TIMEOUT_MS,
      httpAgent,
      httpsAgent,
      validateStatus: (status) => status >= 200 && status < 300, // Reject 4xx and 5xx as errors
    });
  }

  public static getInstance(): DispatchService {
    if (!DispatchService.instance) {
      DispatchService.instance = new DispatchService();
    }
    return DispatchService.instance;
  }

  /**
   * Dispatches a webhook payload to the target URL with cryptographic signature headers.
   *
   * @param targetUrl - The recipient endpoint URL
   * @param payload - The event payload
   * @param idempotencyKey - Unique event identifier
   * @param attempt - The current retry attempt number (1-indexed)
   */
  public async dispatchWebhook(
    targetUrl: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    attempt: number = 1,
    secret?: string,
  ): Promise<DispatchResult> {
    const signature = signerService.signPayload(payload, secret);
    const startTime = Date.now();

    try {
      const response = await this.client.post(targetUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'dispatch-queue-engine/1.0.0',
          'X-Dispatch-Signature': signature,
          'X-Dispatch-Idempotency-Key': idempotencyKey,
          'X-Dispatch-Attempt': String(attempt),
          'X-Dispatch-Timestamp': new Date().toISOString(),
        },
      });

      const durationMs = Date.now() - startTime;
      logger.info('Webhook dispatched successfully:', {
        targetUrl,
        idempotencyKey,
        attempt,
        status: response.status,
        durationMs,
      });

      return {
        statusCode: response.status,
        durationMs,
        responseBody: response.data,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;

      if (axios.isAxiosError(err)) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        const statusText = axiosErr.response?.statusText || axiosErr.message;

        logger.warn('Webhook dispatch failed:', {
          targetUrl,
          idempotencyKey,
          attempt,
          status,
          durationMs,
          errorCode: axiosErr.code,
          errorMessage: axiosErr.message,
        });

        // 4xx errors (except 429 Too Many Requests) are permanent client errors:
        // E.g., 400 Bad Request, 401 Unauthorized, 404 Not Found.
        // Fast-fail them to DLQ immediately via UnrecoverableError to save queue resources.
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw new UnrecoverableError(
            `Non-retryable client error (${status} ${statusText}) from destination: ${targetUrl}`,
          );
        }

        // Retryable errors: 5xx server errors, 429 rate limits, and network connection drops/timeouts
        throw new Error(
          `Retryable dispatch error (${status || axiosErr.code || 'TIMEOUT'}): ${axiosErr.message}`,
        );
      }

      throw err;
    }
  }
}

export const dispatchService = DispatchService.getInstance();
export default dispatchService;
