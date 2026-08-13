/**
 * Layered anti-spam for the booking form.
 *
 * No single check is decisive. A bot has to get past all of them:
 *
 *   1. Origin      — a stated Origin/Referer must be one of our hostnames.
 *   2. Honeypots   — two decoy fields, hidden from people, must stay empty.
 *   3. Token       — signed, single-use, older than MIN_FILL_SECONDS
 *                    (see formToken.mjs, called from the function).
 *   4. Rate limits — per IP per window, per IP per day, site-wide per hour.
 *   5. Content     — a score built from link spam, keyword spam, shouting,
 *                    wrong-script text and other tells; over threshold is out.
 *   6. Duplicates  — the same enquiry twice inside ten minutes is dropped.
 *
 * A direct port of app/SpamGuard.php.
 */
import { createHmac } from 'node:crypto';

import { config } from './config.mjs';

/** Decoy inputs. Real people never see them, so a value means a bot. */
export const HONEYPOTS = ['website', 'company'];

/** Matches a bare host or a full URL anywhere in the text. */
const LINK_PATTERN =
  /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|in|co|uk|ru|cn|de|xyz|top|club|info|online|site|shop|store|biz|link|icu|live|me|io|be)\b(?:\/\S*)?/gi;

/** Places a customer might genuinely link a reference photo from. */
const LINK_ALLOWLIST = new Set([
  'instagram.com', 'pinterest.com', 'pin.it', 'facebook.com', 'fb.com',
  'wa.me', 'drive.google.com', 'photos.app.goo.gl', 'youtube.com', 'youtu.be',
  'stitchavenue.in',
]);

/**
 * Phrases that never appear in a genuine boutique enquiry. Weighted:
 * 3 is instantly fatal at the default threshold, 1–2 needs corroboration.
 */
const KEYWORDS = [
  [3, [
    'seo service', 'seo expert', 'backlink', 'link building', 'guest post',
    'rank higher', 'first page of google', 'increase your traffic',
    'crypto', 'bitcoin', 'forex', 'binary option', 'casino', 'betting',
    'viagra', 'cialis', 'payday loan', 'make money online',
    'work from home', 'nude', 'porn', 'escort', 'sexy girls',
  ]],
  [2, [
    'digital marketing', 'web design service', 'website development service',
    'mobile app development', 'lead generation', 'bulk sms', 'bulk email',
    'unsubscribe', 'this is not spam', 'limited time offer', 'act now',
    'dear sir/madam', 'dear webmaster', 'to the owner of',
  ]],
  [1, [
    'click here', 'buy now', 'free trial', 'no obligation', 'best price',
    'earn money', 'investment opportunity', 'business proposal',
  ]],
];

/* ------------------------- 1. Origin ------------------------- */

/**
 * A cross-site POST is rejected. A request that states no origin at all is
 * allowed through — some browsers omit both headers on same-origin posts —
 * because the signed token still has to be present and valid.
 */
export function originAllowed(headers, host) {
  const allowed = new Set(config.security.allowedHosts.map((h) => h.toLowerCase()));
  if (host) allowed.add(host.toLowerCase().split(':')[0]);

  for (const header of ['origin', 'referer']) {
    const value = headers.get(header);
    if (!value) continue;

    let candidate;
    try {
      candidate = new URL(value).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (!allowed.has(candidate)) return false;
  }
  return true;
}

/* ------------------------ 2. Honeypots ----------------------- */

export function honeypotTripped(input) {
  return HONEYPOTS.some((field) => {
    const value = input[field];
    return typeof value !== 'string' ? value !== undefined : value.trim() !== '';
  });
}

/* ------------------------ 5. Content ------------------------- */

/**
 * @param  {Record<string,string>} clean
 * @return {{score: number, reasons: string[]}}
 */
export function score(clean) {
  const name = clean.name ?? '';
  const notes = clean.notes ?? '';
  // The e-mail address is deliberately left out of this blob: its domain would
  // read as a link, and "gmail.com" is not a spam signal.
  const blob = `${name}\n${notes}`.toLowerCase().trim();

  let total = 0;
  const reasons = [];
  const add = (points, why) => {
    total += points;
    reasons.push(why);
  };

  // Links. Customers do sometimes paste one reference picture, so a single
  // link to a place designs actually live is free; anything else is scored,
  // and two or more is fatal on its own.
  let unsolicited = 0;
  for (const hit of blob.match(LINK_PATTERN) ?? []) {
    const host = hit
      .trim()
      .replace(/^https?:\/\//, '')
      .split(/[/?#]/)[0]
      .replace(/^www\./, '');

    if (!LINK_ALLOWLIST.has(host)) unsolicited++;
  }
  if (unsolicited > 0) add(unsolicited >= 2 ? 4 : 2, `link:${unsolicited}`);

  // Markup or BBCode — a person typing into a textarea uses neither.
  if (/<\s*[a-z!/]|\[\/?(?:url|link|b|i)\b/i.test(blob)) add(3, 'markup');

  // Mail headers pasted into the body: a header-injection attempt.
  if (/^\s*(bcc|cc|to|from|content-type|mime-version)\s*:/im.test(blob)) {
    add(4, 'header_injection');
  }

  for (const [weight, phrases] of KEYWORDS) {
    for (const phrase of phrases) {
      if (blob.includes(phrase)) {
        add(weight, `kw:${phrase}`);
        break; // one hit per weight band is enough
      }
    }
  }

  // Cyrillic is the usual giveaway for the automated stuff. Tamil, Devanagari
  // and other Indic scripts are of course perfectly normal here.
  if (/\p{Script=Cyrillic}/u.test(blob)) add(3, 'cyrillic');

  if (notes !== '') {
    const letters = (notes.match(/\p{L}/gu) ?? []).length;
    const upper = (notes.match(/\p{Lu}/gu) ?? []).length;
    if (letters > 40 && upper / Math.max(1, letters) > 0.7) add(2, 'shouting');

    // Keyboard mashing / filler: the same character nine times over.
    if (/(.)\1{8,}/u.test(notes)) add(2, 'repetition');
    if ((notes.match(/@/g) ?? []).length > 2) add(2, 'many_addresses');
  }

  // A name that is really a sentence, or a name repeated as the message.
  if (name !== '' && notes !== '' && name.toLowerCase() === notes.toLowerCase()) {
    add(2, 'name_equals_notes');
  }

  return { score: total, reasons };
}

/* ----------------------- 6. Duplicates ----------------------- */

export function fingerprint(clean) {
  return createHmac('sha256', config.security.secret)
    .update([
      clean.phoneRaw ?? '',
      (clean.name ?? '').toLowerCase(),
      (clean.notes ?? '').toLowerCase(),
      clean.service ?? '',
    ].join('|'))
    .digest('hex');
}

/** Pseudonymised IP — enough to rate-limit, not enough to be an identifier. */
export function ipKey(ip) {
  return createHmac('sha256', config.security.secret).update(ip).digest('hex').slice(0, 32);
}
