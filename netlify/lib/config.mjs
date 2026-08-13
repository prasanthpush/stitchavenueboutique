/**
 * Configuration, read from Netlify environment variables.
 *
 * On the PHP version this lived in a git-ignored config file. Environment
 * variables are a better fit here: the App Password never touches the repo or
 * the deployed bundle, and it can be rotated in the Netlify UI without a
 * redeploy of anything but the function.
 *
 * Set these under Site configuration → Environment variables:
 *
 *   SMTP_USER       the Gmail address that sends           (required)
 *   SMTP_PASS       its 16-character Google App Password   (required)
 *   FORM_SECRET     random 64-char hex, signs form tokens  (required)
 *   MAIL_TO         where enquiries land, comma-separated  (required)
 *   ALLOWED_HOSTS   comma-separated hostnames of the site  (required)
 *
 *   MAIL_FROM_NAME  display name on outgoing mail          (optional)
 *   SMTP_HOST/PORT  override the Gmail defaults            (optional)
 *   AUTOREPLY       "off" disables the customer copy       (optional)
 *   SPAM_THRESHOLD  score at which a message is refused    (optional)
 *   DEBUG           "on" returns real error text           (optional)
 */

const str = (name, fallback = '') => (process.env[name] ?? fallback).toString().trim();
const num = (name, fallback) => {
  const raw = Number.parseInt(str(name), 10);
  return Number.isFinite(raw) ? raw : fallback;
};
const list = (name, fallback = []) => {
  const raw = str(name);
  if (raw === '') return fallback;
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
};

/**
 * A recipient list, with unusable entries dropped rather than allowed to fail
 * the send. One typo in MAIL_CC should not cost the boutique the enquiry, so
 * the bad entry is logged and the message still goes to everyone else.
 */
const recipients = (name) => {
  const all = list(name);
  const good = all.filter((address) => /^[^\s@,]+@[^\s@,.]+(\.[^\s@,.]+)+$/.test(address));

  const dropped = all.filter((address) => !good.includes(address));
  if (dropped.length > 0) {
    console.error(`[config] ${name} has unusable addresses, ignoring:`, dropped.join(', '));
  }
  return good;
};

export const config = {
  smtp: {
    host: str('SMTP_HOST', 'smtp.gmail.com'),
    port: num('SMTP_PORT', 587),
    user: str('SMTP_USER'),
    // Google displays App Passwords in groups of four. The spaces are
    // presentation only and SMTP AUTH fails if they are sent.
    pass: str('SMTP_PASS').replace(/\s+/g, ''),
  },

  from: {
    // Gmail rewrites From to the authenticated account unless the address is
    // a verified "Send mail as" alias, so this always tracks SMTP_USER.
    email: str('SMTP_USER'),
    name: str('MAIL_FROM_NAME', 'Stitch Avenue Website'),
  },

  // Recipients of the enquiry notification. CC is visible to everyone on the
  // message; BCC is not. All three are comma-separated.
  to: recipients('MAIL_TO'),
  cc: recipients('MAIL_CC'),
  bcc: recipients('MAIL_BCC'),

  autoreply: {
    enabled: str('AUTOREPLY', 'on').toLowerCase() !== 'off',
    subject: 'We have your request — Stitch Avenue Boutique',
  },

  business: {
    name: 'Stitch Avenue Boutique',
    phone: '+91 70949 51438',
    address: 'No. 48A, Sathya Avenue, Mamallan Nagar, Kanchipuram, Tamil Nadu',
    hours: 'Monday – Saturday, 10:00 AM – 8:30 PM',
    timezone: 'Asia/Kolkata',
  },

  security: {
    secret: str('FORM_SECRET'),
    minFillSeconds: num('MIN_FILL_SECONDS', 4),
    tokenTtl: num('TOKEN_TTL', 7200),
    allowedHosts: list('ALLOWED_HOSTS', ['localhost', '127.0.0.1']),
    verifyEmailDomain: str('VERIFY_EMAIL_DOMAIN', 'on').toLowerCase() !== 'off',
    spamThreshold: num('SPAM_THRESHOLD', 3),
  },

  rateLimit: {
    perIpWindow: num('RATE_IP_WINDOW', 900),
    perIpMax: num('RATE_IP_MAX', 3),
    perIpDayMax: num('RATE_IP_DAY_MAX', 8),
    globalHourMax: num('RATE_GLOBAL_HOUR_MAX', 60),
  },

  debug: str('DEBUG').toLowerCase() === 'on',
};

/**
 * Which required settings are missing. The endpoints refuse to run rather
 * than half-work, so a misconfigured deploy fails loudly instead of dropping
 * enquiries on the floor.
 */
export function missingConfig() {
  const missing = [];
  if (!config.smtp.user) missing.push('SMTP_USER');
  if (!config.smtp.pass) missing.push('SMTP_PASS');
  if (!config.security.secret || config.security.secret.length < 32) missing.push('FORM_SECRET');
  if (config.to.length === 0) missing.push('MAIL_TO');
  return missing;
}
