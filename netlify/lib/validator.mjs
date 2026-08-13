/**
 * Strict server-side validation for the booking form.
 *
 * Nothing that reaches the mailer has been trusted: every field is
 * length-capped, pattern-checked and normalised here first. Single-line fields
 * reject CR/LF outright, which is what closes off SMTP header injection.
 *
 * A direct port of app/Validator.php — the rules are deliberately identical.
 */
import { promises as dns } from 'node:dns';

import { config } from './config.mjs';

/** Form value → human label used in the e-mail. */
export const SERVICES = {
  'custom-stitching': 'Custom stitching',
  'boutique-wear': 'Boutique wear',
  'bridal-occasion': 'Bridal / occasion wear',
  other: 'Something else',
};

const MAX_NAME = 60;
const MAX_EMAIL = 100;
const MAX_NOTES = 700;
const MAX_DAYS_AHEAD = 180;

/** Letters, marks (Tamil/Devanagari vowel signs), spaces and name punctuation. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

/**
 * Pull one field as a trimmed string. Anything that is not a string — an array
 * smuggled in as `name[]`, say — becomes empty.
 */
function raw(input, key) {
  const value = input[key];
  if (typeof value !== 'string') return '';

  return value
    // Strip C0/C1 controls except tab and newline.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** Collapse whitespace runs and forbid line breaks — for header-bound fields. */
const singleLine = (value) => value.replace(/\s+/gu, ' ').trim();

function validateName(value, errors, clean) {
  const name = singleLine(value);

  if (name === '') return void (errors.name = 'Please tell us your name.');
  if ([...name].length < 2) return void (errors.name = 'That name looks too short.');
  if ([...name].length > MAX_NAME) {
    return void (errors.name = `Please keep the name under ${MAX_NAME} characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    return void (errors.name = 'Please use letters only — no digits, links or symbols.');
  }
  if ((name.match(/\p{L}/gu) ?? []).length < 2) {
    return void (errors.name = 'Please enter your full name.');
  }

  clean.name = name;
}

/**
 * Indian mobile numbers: ten digits starting 6–9, with an optional
 * +91 / 91 / 0 prefix. Stored normalised so duplicates are easy to spot.
 */
function validatePhone(value, errors, clean) {
  let digits = value.replace(/[^0-9+]/g, '');

  if (digits === '') return void (errors.phone = 'Please give us a phone number.');

  digits = digits.replace(/^\++/, '');
  for (const prefix of ['91', '0']) {
    if (digits.length > 10 && digits.startsWith(prefix)) {
      digits = digits.slice(prefix.length);
      break;
    }
  }

  if (!/^[6-9][0-9]{9}$/.test(digits)) {
    return void (errors.phone = 'Enter a 10-digit Indian mobile number.');
  }

  clean.phone = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  clean.phoneRaw = `+91${digits}`;
}

/** Required, and it must be deliverable — we reply and acknowledge to it. */
async function validateEmail(value, errors, clean) {
  const email = singleLine(value);

  if (email === '') return void (errors.email = 'Please give us an email address.');
  if (email.length > MAX_EMAIL) return void (errors.email = 'That email address is too long.');

  // Deliberately conservative: one @, no whitespace, a dotted domain.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    return void (errors.email = 'That email address does not look right.');
  }

  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();

  if (config.security.verifyEmailDomain) {
    // Catches typo domains (gmail.con) and the throwaway domains bots invent.
    // Set VERIFY_EMAIL_DOMAIN=off if the resolver proves unreliable — a dead
    // resolver looks the same as a dead domain from here.
    const resolvable = await hasMailExchanger(domain);
    if (!resolvable) {
      return void (errors.email = 'We could not find that email domain. Please check the spelling.');
    }
  }

  clean.email = `${email.slice(0, at)}@${domain}`;
}

async function hasMailExchanger(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length > 0) return true;
  } catch {
    /* fall through to an A lookup */
  }
  try {
    const a = await dns.resolve4(domain);
    return a.length > 0;
  } catch {
    return false;
  }
}

/** Optional preferred date: today .. +180 days, and a real calendar date. */
function validateDate(value, errors, clean) {
  const date = singleLine(value);
  if (date === '') return;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return void (errors.date = 'Please pick a valid date.');

  const [, y, m, d] = match.map(Number);
  const picked = new Date(Date.UTC(y, m - 1, d));

  // Rejects 2026-02-30, which Date would otherwise roll into March.
  if (
    picked.getUTCFullYear() !== y ||
    picked.getUTCMonth() !== m - 1 ||
    picked.getUTCDate() !== d
  ) {
    return void (errors.date = 'Please pick a valid date.');
  }

  const today = startOfBusinessToday();
  const limit = new Date(today.getTime() + MAX_DAYS_AHEAD * 86400000);

  if (picked < today) return void (errors.date = 'Please pick a date that has not passed.');
  if (picked > limit) return void (errors.date = 'Please pick a date within the next six months.');

  clean.date = date;
  clean.dateHuman = picked.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** "Today" in the shop's timezone, as a UTC-midnight Date for comparison. */
function startOfBusinessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.business.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const [y, m, d] = parts.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function validateService(value, errors, clean) {
  const service = singleLine(value);

  if (!Object.hasOwn(SERVICES, service)) {
    return void (errors.service = 'Please choose one of the listed services.');
  }

  clean.service = service;
  clean.serviceLabel = SERVICES[service];
}

function validateNotes(value, errors, clean) {
  if (value === '') return;
  if ([...value].length > MAX_NOTES) {
    return void (errors.notes = `Please keep this under ${MAX_NOTES} characters.`);
  }

  clean.notes = value.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param  {Record<string, unknown>} input Parsed form body
 * @return {Promise<{valid: boolean, errors: Record<string,string>, clean: Record<string,string>}>}
 */
export async function validate(input) {
  const errors = {};
  const clean = {};

  validateName(raw(input, 'name'), errors, clean);
  validatePhone(raw(input, 'phone'), errors, clean);
  await validateEmail(raw(input, 'email'), errors, clean);
  validateDate(raw(input, 'date'), errors, clean);
  validateService(raw(input, 'service'), errors, clean);
  validateNotes(raw(input, 'notes'), errors, clean);

  return { valid: Object.keys(errors).length === 0, errors, clean };
}
