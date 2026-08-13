/**
 * Guard state on Netlify Blobs.
 *
 * The PHP version kept everything in one JSON file mutated under an exclusive
 * flock. Serverless has no persistent filesystem and Blobs offer no locking,
 * so the design changes shape: one key per subject instead of one shared
 * document. That keeps concurrent submissions off each other's keys, so the
 * only remaining race is two requests touching the *same* key within the same
 * few milliseconds.
 *
 * That residual race is accepted deliberately. Losing it means a third
 * submission occasionally slips past a 3-per-window limit, or a token is
 * accepted twice in a dead heat — neither of which matters for a boutique
 * enquiry form. Blocking it would need a real transactional store.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'stitchavenue-form-guard';

let cached = null;

function store() {
  if (!cached) {
    cached = getStore({ name: STORE_NAME, consistency: 'strong' });
  }
  return cached;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

async function readJson(key) {
  try {
    return await store().get(key, { type: 'json' });
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  try {
    await store().setJSON(key, value);
    return true;
  } catch {
    return false;
  }
}

async function remove(key) {
  try {
    await store().delete(key);
  } catch {
    /* nothing to do */
  }
}

/* ------------------------------------------------------------------ */
/* Single-use tokens                                                   */
/* ------------------------------------------------------------------ */

/**
 * Burn a nonce.
 * @returns {Promise<true|false|null>} true = first use, false = replay,
 *          null = storage unreachable (caller decides how to fail).
 */
export async function burnNonce(nonce, expiresAt) {
  const key = `nonce/${nonce}`;
  const existing = await readJson(key);

  if (existing && typeof existing.exp === 'number') {
    if (existing.exp > nowSeconds()) return false;
    // Expired leftover — reuse of the key is fine, the token itself is
    // rejected on age before it ever reaches here.
  }

  const ok = await writeJson(key, { exp: expiresAt });
  return ok ? true : null;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Record an attempt and report whether it is within the limits.
 * @returns {Promise<{allowed: boolean, reason: string, retryAfter: number}>}
 */
export async function recordAttempt(ipKey, limits) {
  const now = nowSeconds();
  const dayAgo = now - 86400;
  const hourAgo = now - 3600;

  const ipRecord = (await readJson(`ip/${ipKey}`)) ?? { stamps: [] };
  const stamps = (Array.isArray(ipRecord.stamps) ? ipRecord.stamps : [])
    .filter((ts) => typeof ts === 'number' && ts > dayAgo);

  const inWindow = stamps.filter((ts) => ts > now - limits.perIpWindow);

  if (inWindow.length >= limits.perIpMax) {
    const retry = limits.perIpWindow - (now - Math.min(...inWindow));
    return { allowed: false, reason: 'ip_window', retryAfter: Math.max(30, retry) };
  }
  if (stamps.length >= limits.perIpDayMax) {
    return { allowed: false, reason: 'ip_day', retryAfter: 3600 };
  }

  const globalRecord = (await readJson('global')) ?? { stamps: [] };
  const globalStamps = (Array.isArray(globalRecord.stamps) ? globalRecord.stamps : [])
    .filter((ts) => typeof ts === 'number' && ts > hourAgo);

  if (globalStamps.length >= limits.globalHourMax) {
    return { allowed: false, reason: 'global_hour', retryAfter: 900 };
  }

  stamps.push(now);
  globalStamps.push(now);

  const wroteIp = await writeJson(`ip/${ipKey}`, { stamps });
  await writeJson('global', { stamps: globalStamps });

  // Fail closed: if the counter cannot be persisted, the limiter is blind
  // and an attacker could submit without bound.
  if (!wroteIp) {
    return { allowed: false, reason: 'store_unavailable', retryAfter: 60 };
  }

  return { allowed: true, reason: '', retryAfter: 0 };
}

/* ------------------------------------------------------------------ */
/* Duplicate suppression                                               */
/* ------------------------------------------------------------------ */

const DUPLICATE_WINDOW = 600;

/** True when this exact enquiry already arrived in the last ten minutes. */
export async function isDuplicate(fingerprint) {
  const key = `fp/${fingerprint}`;
  const existing = await readJson(key);

  if (existing && typeof existing.exp === 'number' && existing.exp > nowSeconds()) {
    return true;
  }

  // A storage failure here lets the enquiry through: a duplicated e-mail is a
  // nuisance, a false positive silently loses a real customer.
  await writeJson(key, { exp: nowSeconds() + DUPLICATE_WINDOW });
  return false;
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

/**
 * Blobs have no TTL, so spent nonces and fingerprints would accumulate
 * forever. Sweeping on a small fraction of requests keeps it bounded without
 * putting a list() on the hot path of every submission.
 */
export async function maybeSweep(probability = 0.02) {
  if (Math.random() >= probability) return 0;

  const now = nowSeconds();
  let removed = 0;

  try {
    for (const prefix of ['nonce/', 'fp/']) {
      const { blobs } = await store().list({ prefix });
      for (const blob of blobs) {
        const record = await readJson(blob.key);
        if (!record || typeof record.exp !== 'number' || record.exp <= now) {
          await remove(blob.key);
          removed++;
        }
      }
    }
  } catch {
    /* sweeping is best-effort */
  }

  return removed;
}
