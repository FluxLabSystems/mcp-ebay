/**
 * Short-lived artifact-upload tokens — SDD v0.5 §11.5/§16. HMAC-signed,
 * bound to the device, 15-minute TTL, issued at device.ready.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ARTIFACT_TOKEN_TTL_SECONDS } from '@browser-bridge/protocol';

export class ArtifactTokenIssuer {
  private readonly secret: Buffer;

  constructor(secret?: string) {
    this.secret = Buffer.from(secret ?? randomBytes(32).toString('base64url'), 'utf8');
  }

  issue(deviceId: string, now: number = Date.now()): { token: string; expiresAt: Date } {
    const exp = Math.floor(now / 1000) + ARTIFACT_TOKEN_TTL_SECONDS;
    const payload = `${deviceId}.${exp}`;
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return {
      token: `at.${Buffer.from(deviceId, 'utf8').toString('base64url')}.${exp}.${sig}`,
      expiresAt: new Date(exp * 1000),
    };
  }

  verify(token: string, now: number = Date.now()): { deviceId: string } | null {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'at') return null;
    let deviceId: string;
    try {
      deviceId = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const exp = Number.parseInt(parts[2]!, 10);
    if (!Number.isFinite(exp) || exp * 1000 <= now) return null;
    const expected = createHmac('sha256', this.secret).update(`${deviceId}.${exp}`).digest('base64url');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(parts[3]!, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { deviceId };
  }
}
