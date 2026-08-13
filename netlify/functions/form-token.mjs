/**
 * Issues a single-use token for the booking form.
 *
 * index.html stays a plain static file, so the token is fetched here on load.
 * Its issue time doubles as the start of the "did a human really spend time
 * filling this in?" clock.
 */
import { config as appConfig, missingConfig } from '../lib/config.mjs';
import { issue } from '../lib/formToken.mjs';

/** Netlify Functions v2 routing — this is the public URL. */
export const config = { path: '/api/form-token' };

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });

export default async function handler(request) {
  if (request.method !== 'GET') {
    return json(405, { ok: false, message: 'Method not allowed.' });
  }

  const missing = missingConfig();
  if (missing.length > 0) {
    console.error('[not_configured] missing env vars:', missing.join(', '));
    return json(503, {
      ok: false,
      message: `The form is not connected yet. Please call us on ${appConfig.business.phone}.`,
    });
  }

  return json(200, {
    ok: true,
    token: issue(),
    min_wait: appConfig.security.minFillSeconds,
  });
}
