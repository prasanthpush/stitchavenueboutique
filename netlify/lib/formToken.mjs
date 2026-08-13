/**
 * One-time, signed form tokens.
 *
 * Stateless by design — the issue time and a random nonce are signed with
 * FORM_SECRET, so no session cookie is needed and index.html stays a plain
 * cacheable static file. The nonce is burned on first use, which makes the
 * token single-shot: replaying a captured POST fails.
 *
 * Token: <issued at>.<nonce>.<base64url hmac-sha256>
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from './config.mjs';
import { burnNonce, nowSeconds } from './store.mjs';

export const TokenResult = {
  OK: 'ok',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad_signature',
  EXPIRED: 'expired',
  FROM_THE_FUTURE: 'from_the_future',
  TOO_FAST: 'too_fast',
  REPLAYED: 'replayed',
  UNVERIFIABLE: 'unverifiable',
};

function sign(payload) {
  return createHmac('sha256', config.security.secret)
    .update(payload)
    .digest('base64url');
}

export function issue() {
  const issuedAt = nowSeconds();
  const nonce = randomBytes(12).toString('hex');

  return `${issuedAt}.${nonce}.${sign(`${issuedAt}.${nonce}`)}`;
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * @returns {Promise<{reason: string, age: number}>}
 */
export async function verify(token) {
  if (typeof token !== 'string' || token === '') {
    return { reason: TokenResult.MALFORMED, age: 0 };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { reason: TokenResult.MALFORMED, age: 0 };
  }

  const [issuedAt, nonce, signature] = parts;

  if (!/^\d+$/.test(issuedAt) || !/^[0-9a-f]{24}$/.test(nonce)) {
    return { reason: TokenResult.MALFORMED, age: 0 };
  }

  if (!safeEqual(sign(`${issuedAt}.${nonce}`), signature)) {
    return { reason: TokenResult.BAD_SIGNATURE, age: 0 };
  }

  const age = nowSeconds() - Number.parseInt(issuedAt, 10);

  // Seconds of clock skew are normal; minutes means a forged stamp.
  if (age < -30) return { reason: TokenResult.FROM_THE_FUTURE, age };
  if (age > config.security.tokenTtl) return { reason: TokenResult.EXPIRED, age };
  if (age < config.security.minFillSeconds) return { reason: TokenResult.TOO_FAST, age };

  const burned = await burnNonce(nonce, Number.parseInt(issuedAt, 10) + config.security.tokenTtl);
  if (burned === null) return { reason: TokenResult.UNVERIFIABLE, age };
  if (burned === false) return { reason: TokenResult.REPLAYED, age };

  return { reason: TokenResult.OK, age };
}
