import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PresenceUser } from './index.js';

/**
 * Connection tokens: the web app signs who you are and which workspace you may join, the
 * collaboration server verifies it. HMAC-SHA256 over a JSON payload with a shared secret.
 *
 * With real auth the web app signs the same claims from the session instead of the mock-user
 * cookie; the collaboration server doesn't change.
 */
export interface TokenClaims {
  user: PresenceUser;
  /** Workspace slug the token is valid for. */
  ws: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

const DEV_SECRET = 'lineage-dev-secret-change-me';

/** The shared secret. Required in production; a fixed dev value otherwise. */
export function collabSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env['LINEAGE_COLLAB_SECRET'];
  if (s) return s;
  if (env['NODE_ENV'] === 'production' && env['LINEAGE_ALLOW_DEV_SECRET'] !== '1') {
    throw new Error('Set LINEAGE_COLLAB_SECRET (the same value for the web app and the collaboration server).');
  }
  return DEV_SECRET;
}

const b64 = (s: Buffer | string) => Buffer.from(s).toString('base64url');
const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest();

export function signToken(input: { user: PresenceUser; ws: string; ttlSeconds?: number }, secret: string, now = Date.now()): string {
  const claims: TokenClaims = { user: input.user, ws: input.ws, exp: Math.floor(now / 1000) + (input.ttlSeconds ?? 12 * 3600) };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(mac(body, secret))}`;
}

/** Claims if the token is authentic and unexpired, else `undefined`. */
export function verifyToken(token: string, secret: string, now = Date.now()): TokenClaims | undefined {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return undefined;
  const expected = mac(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return undefined;
    if (!claims.user?.id || typeof claims.ws !== 'string') return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
