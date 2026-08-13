/**
 * Booking-form endpoint.
 *
 * Checks run cheapest-first, so an obvious bot is turned away before we spend
 * a DNS lookup or an SMTP connection on it:
 *
 *   method → size → origin → honeypot → token/timing → rate limit
 *          → field validation → spam score → duplicate → send
 *
 * Every rejection is logged with its real reason; the caller only ever sees a
 * generic message, so a bot cannot use the response to work out which layer it
 * tripped and iterate against it.
 *
 * A direct port of api/book.php.
 */
import { config as appConfig, missingConfig } from '../lib/config.mjs';
import { TokenResult, verify } from '../lib/formToken.mjs';
import { send } from '../lib/mailer.mjs';
import {
  fingerprint, honeypotTripped, ipKey, originAllowed, score,
} from '../lib/spamGuard.mjs';
import { isDuplicate, maybeSweep, recordAttempt } from '../lib/store.mjs';
import { validate } from '../lib/validator.mjs';

/** Netlify Functions v2 routing — this is the public URL. */
export const config = { path: '/api/book' };

const MAX_BODY_BYTES = 8192;

const json = (status, payload, extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extraHeaders,
    },
  });

/** Log the real reason, answer with something bland. */
function reject(status, reason, message, extra = {}, headers = {}) {
  console.warn('[rejected]', JSON.stringify({ reason, status, ...extra }));
  return json(status, { ok: false, message }, headers);
}

function clientIp(request) {
  // Netlify terminates TLS at its edge and sets these itself; the raw
  // X-Forwarded-For is only trustworthy because we are behind that edge.
  const candidates = [
    request.headers.get('x-nf-client-connection-ip'),
    (request.headers.get('x-forwarded-for') ?? '').split(',')[0],
    request.headers.get('client-ip'),
  ];

  for (const candidate of candidates) {
    const ip = (candidate ?? '').trim();
    if (ip !== '') return ip;
  }
  return '0.0.0.0';
}

export default async function handler(request) {
  const phone = appConfig.business.phone;

  /* ----------------------------- 0. Transport ---------------------------- */

  if (request.method !== 'POST') {
    return json(405, { ok: false, message: 'Method not allowed.' });
  }

  const missing = missingConfig();
  if (missing.length > 0) {
    console.error('[not_configured] missing env vars:', missing.join(', '));
    return json(503, {
      ok: false,
      message: `The form is not connected yet. Please call us on ${phone}.`,
    });
  }

  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return reject(413, 'body_too_large', 'That message is too long. Please shorten it and try again.');
  }

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return reject(415, 'bad_content_type',
      'We could not read that submission. Please reload the page and try again.');
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return reject(413, 'body_too_large', 'That message is too long. Please shorten it and try again.');
  }

  const input = Object.fromEntries(new URLSearchParams(body));
  const ip = clientIp(request);

  /* ------------------------------ 1. Origin ------------------------------ */

  if (!originAllowed(request.headers, request.headers.get('host'))) {
    return reject(403, 'bad_origin', 'This form can only be used from our website.', {
      origin: request.headers.get('origin'),
      referer: request.headers.get('referer'),
    });
  }

  /* ----------------------------- 2. Honeypot ----------------------------- */

  if (honeypotTripped(input)) {
    return reject(422, 'honeypot', `We could not process that request. Please call us on ${phone}.`);
  }

  /* --------------------------- 3. Token & timing -------------------------- */

  const verdict = await verify(input.form_token ?? '');

  if (verdict.reason !== TokenResult.OK) {
    const stale = verdict.reason === TokenResult.EXPIRED || verdict.reason === TokenResult.REPLAYED;

    return reject(
      stale ? 409 : 403,
      `token_${verdict.reason}`,
      stale
        ? 'This form has been open a while. Please reload the page and send it again.'
        : 'We could not verify that submission. Please reload the page and try again.',
      { age: verdict.age },
    );
  }

  /* ---------------------------- 4. Rate limiting -------------------------- */

  const limit = await recordAttempt(ipKey(ip), appConfig.rateLimit);
  if (!limit.allowed) {
    return reject(429, `rate_${limit.reason}`,
      'You have already sent us a few requests. Please give us a little time to reply, '
      + `or call ${phone}.`,
      {}, { 'Retry-After': String(limit.retryAfter) });
  }

  /* --------------------------- 5. Field validation ------------------------ */

  const { valid, errors, clean } = await validate(input);
  if (!valid) {
    console.warn('[rejected]', JSON.stringify({ reason: 'validation', fields: Object.keys(errors) }));
    return json(422, {
      ok: false,
      message: 'Please check the highlighted fields.',
      errors,
    });
  }

  /* ----------------------------- 6. Spam score ---------------------------- */

  const spam = score(clean);
  if (spam.score >= appConfig.security.spamThreshold) {
    return reject(422, 'spam_content',
      `We could not process that message. If this is a genuine enquiry, please call us on ${phone}.`,
      { score: spam.score, signals: spam.reasons });
  }

  /* ------------------------------ 7. Duplicate ---------------------------- */

  if (await isDuplicate(fingerprint(clean))) {
    return json(200, {
      ok: true,
      message: 'We already have this request — no need to send it twice. We will be in touch shortly.',
    });
  }

  /* -------------------------------- 8. Send ------------------------------- */

  let result;
  try {
    result = await send(clean, { ip });
  } catch (error) {
    // The full enquiry goes to the log so nothing is lost when Gmail is
    // unreachable — these lines are recoverable from the Netlify function log.
    console.error('[send_failed]', JSON.stringify({
      error: error?.message ?? String(error),
      enquiry: {
        name: clean.name,
        phone: clean.phone,
        email: clean.email ?? null,
        service: clean.serviceLabel,
        date: clean.date ?? null,
        notes: clean.notes ?? null,
      },
    }));

    return json(500, {
      ok: false,
      message: `We could not send that just now. Please call or WhatsApp us on ${phone}.`,
      detail: appConfig.debug ? (error?.message ?? String(error)) : null,
    });
  }

  console.log('[submission]', JSON.stringify({
    name: clean.name,
    phone: clean.phone,
    email: clean.email ?? null,
    service: clean.serviceLabel,
    date: clean.date ?? null,
    spam_score: spam.score,
    acknowledged: result.acknowledged,
  }));

  // Housekeeping runs after the reply is composed, on a small fraction of
  // requests, so it never sits on the customer's critical path.
  maybeSweep().catch(() => {});

  const firstName = clean.name.split(' ')[0];

  return json(200, {
    ok: true,
    message: result.acknowledged
      ? `Thank you, ${firstName}. A confirmation is on its way to your inbox — we will call you shortly.`
      : `Thank you, ${firstName}. We have your request and will call you shortly to confirm your slot.`,
  });
}
