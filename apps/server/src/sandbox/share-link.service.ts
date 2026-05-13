import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';

/**
 * Anonymous read-only preview share link (PRD §F7.6).
 *  - JWT-like signed token (HMAC-SHA256) with sandbox id + exp.
 *  - 24h TTL by default, configurable via PREVIEW_SHARE_TTL_HOURS.
 *  - Reverse proxy validates the token, refuses any non-GET request.
 *  - Revocation list (Redis SET) lets owner invalidate immediately.
 */

export interface SignedShare {
  url: string;
  token: string;
  expiresAt: string;
}

@Injectable()
export class ShareLinkService {
  private readonly secret = process.env.PREVIEW_SHARE_SECRET ?? randomBytes(32).toString('hex');
  private readonly ttlMs =
    Number(process.env.PREVIEW_SHARE_TTL_HOURS ?? 24) * 60 * 60 * 1000;

  sign(sandboxId: string, baseUrl: string): SignedShare {
    const exp = Date.now() + this.ttlMs;
    const payload = `${sandboxId}.${exp}`;
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;
    return {
      url: `${baseUrl}?t=${token}`,
      token,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  verify(token: string): { ok: true; sandboxId: string } | { ok: false; reason: string } {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };
    const payload = Buffer.from(payloadB64, 'base64url').toString();
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (expected !== sig) return { ok: false, reason: 'bad-sig' };
    const [sandboxId, expStr] = payload.split('.');
    if (!sandboxId || !expStr) return { ok: false, reason: 'bad-payload' };
    if (Date.now() > Number(expStr)) return { ok: false, reason: 'expired' };
    return { ok: true, sandboxId };
  }
}
