import crypto from 'crypto';
import { env } from '../config/env';

export class SignerService {
  private static instance: SignerService | null = null;
  private defaultSecret: string;

  private constructor() {
    this.defaultSecret = env.WEBHOOK_SECRET;
  }

  public static getInstance(): SignerService {
    if (!SignerService.instance) {
      SignerService.instance = new SignerService();
    }
    return SignerService.instance;
  }

  /**
   * Generates an HMAC-SHA256 signature for the given payload.
   *
   * @param payload - The webhook payload object to be dispatched
   * @param secret - Optional override secret (defaults to env.WEBHOOK_SECRET)
   * @returns Formatted signature: "sha256=<hex_digest>"
   */
  public signPayload(payload: object, secret?: string): string {
    const key = secret || this.defaultSecret;
    const serialized = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(serialized);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Cryptographically verifies an incoming webhook signature using constant-time comparison
   * to eliminate timing side-channel attack vectors.
   *
   * @param payload - The received payload object
   * @param signatureHeader - The signature header (e.g. "sha256=abcdef...")
   * @param secret - Optional override secret
   * @returns true if signature is authentic, false otherwise
   */
  public verifySignature(payload: object, signatureHeader: string, secret?: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const expectedSignature = this.signPayload(payload, secret);
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }
}

export const signerService = SignerService.getInstance();
export default signerService;
