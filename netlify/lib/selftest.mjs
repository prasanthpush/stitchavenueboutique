/**
 * Offline checks for the ported form logic.
 *
 * Mirrors the PHP test suite so the two backends can be compared directly.
 * Runs without Netlify's runtime: Blobs-backed state is stubbed, and the
 * mailer is exercised through nodemailer's JSON transport, which builds a real
 * message without opening a socket.
 *
 *   node netlify/lib/selftest.mjs
 */
process.env.FORM_SECRET ||= 'a'.repeat(64);
process.env.SMTP_USER ||= 'sender@example.com';
process.env.SMTP_PASS ||= 'xxxxxxxxxxxxxxxx';
process.env.MAIL_TO ||= 'boutique@example.com';
process.env.VERIFY_EMAIL_DOMAIN ||= 'off';
process.env.ALLOWED_HOSTS ||= 'localhost,127.0.0.1,stitchavenue.in';

const { config, missingConfig } = await import('./config.mjs');
const { validate, SERVICES } = await import('./validator.mjs');
const { score, honeypotTripped, originAllowed, fingerprint, ipKey } = await import('./spamGuard.mjs');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

/* ------------------------------ config ------------------------------ */
console.log('=== config ===');
check('all required env vars satisfied', missingConfig().length === 0, missingConfig().join(','));
check('app password spaces stripped', config.smtp.pass === 'xxxxxxxxxxxxxxxx');

/* ----------------------------- validator ---------------------------- */
console.log('\n=== validator ===');
const base = { name: 'Meera Nair', phone: '9876543210', email: 'a@b.com', service: 'custom-stitching' };

const cases = [
  [base, true, 'plain valid'],
  [{ ...base, name: 'கயல்விழி முருகன்', phone: '+91 98765 43210' }, true, 'Tamil name, +91 prefix'],
  [{ ...base, name: "Mary-Anne D'Souza", phone: '09876543210' }, true, 'hyphen/apostrophe, 0 prefix'],
  [{ ...base, name: 'A' }, false, 'one-letter name rejected'],
  [{ ...base, name: 'Meera <b>' }, false, 'markup in name rejected'],
  [{ ...base, name: 'Meera123' }, false, 'digits in name rejected'],
  [{ ...base, name: 'Meera\r\nBcc: victim@x.com' }, false, 'CRLF header injection rejected'],
  [{ ...base, name: ['array'] }, false, 'array smuggled as name[] rejected'],
  [{ ...base, phone: '1234567890' }, false, 'landline-style prefix rejected'],
  [{ ...base, phone: '98765432101' }, false, '11 digits rejected'],
  [{ ...base, email: '' }, false, 'blank email rejected (now required)'],
  [{ ...base, email: 'a@b' }, false, 'email without TLD rejected'],
  [{ ...base, email: 'not-an-email' }, false, 'malformed email rejected'],
  [{ ...base, service: 'hacked' }, false, 'service outside whitelist rejected'],
  [{ ...base, notes: 'x'.repeat(701) }, false, '701-char note rejected'],
  [{ ...base, date: '2026-02-30' }, false, 'impossible date rejected'],
  [{ ...base, date: '2020-01-01' }, false, 'past date rejected'],
  [{ ...base, date: '2099-01-01' }, false, 'date beyond 6 months rejected'],
];

for (const [input, expected, label] of cases) {
  const { valid, errors } = await validate(input);
  check(label, valid === expected, valid === expected ? '' : JSON.stringify(errors));
}

const { clean } = await validate({
  name: '  Meera   Nair ', phone: '+91-98765-43210',
  email: 'Meera@EXAMPLE.com', service: 'bridal-occasion',
});
check('name whitespace collapsed', clean.name === 'Meera Nair', clean.name);
check('phone normalised', clean.phone === '+91 98765 43210', clean.phone);
check('phoneRaw normalised', clean.phoneRaw === '+919876543210', clean.phoneRaw);
check('email domain lowercased', clean.email === 'Meera@example.com', clean.email);
check('service label mapped', clean.serviceLabel === SERVICES['bridal-occasion'], clean.serviceLabel);

const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const { clean: dated, valid: dateValid } = await validate({ ...base, date: future });
check('near-future date accepted', dateValid, JSON.stringify(dated));
check('date humanised', Boolean(dated.dateHuman), dated.dateHuman ?? '-');

/* ----------------------------- spam guard --------------------------- */
console.log(`\n=== spam guard (threshold ${config.security.spamThreshold}) ===`);
const threshold = config.security.spamThreshold;
const spamCases = [
  [{ name: 'Meera Nair', notes: 'Reception gown for my sister, deep red silk, needed by Deepavali.' }, false, 'genuine enquiry'],
  [{ name: 'Meera Nair', notes: 'I like this design: instagram.com/p/abc123' }, false, 'one Instagram reference allowed'],
  [{ name: 'Meera Nair', notes: 'Ref https://pinterest.com/pin/9 and instagram.com/p/x' }, false, 'two allowlisted links allowed'],
  [{ name: 'John', notes: 'Visit https://cheap-seo.xyz for backlink packages' }, true, 'link + keyword'],
  [{ name: 'John', notes: 'See www.a.top and www.b.club' }, true, 'two unknown links alone'],
  [{ name: 'John', notes: 'We offer SEO service, rank higher on google' }, true, 'keyword spam, no link'],
  [{ name: 'Иван Петров', notes: 'Здравствуйте' }, true, 'Cyrillic'],
  [{ name: 'John', notes: 'Bcc: victim@example.com\nContent-Type: text/html' }, true, 'header injection in body'],
  [{ name: 'John', notes: 'BUY NOW LIMITED TIME OFFER ACT NOW CLICK HERE FOR FREE TRIAL TODAY' }, true, 'shouting + keywords'],
  [{ name: 'John', notes: '<a href="x">click</a>' }, true, 'HTML markup'],
];

for (const [input, expectBlocked, label] of spamCases) {
  const result = score(input);
  check(label, (result.score >= threshold) === expectBlocked,
    `score=${result.score} ${result.reasons.join(',')}`);
}

check('honeypot: empty passes', !honeypotTripped({ website: '', company: '' }));
check('honeypot: filled trips', honeypotTripped({ website: 'http://spam.ru', company: '' }));

const headers = (obj) => new Headers(obj);
check('origin: same site allowed', originAllowed(headers({ origin: 'https://stitchavenue.in' }), 'stitchavenue.in'));
check('origin: cross site refused', !originAllowed(headers({ origin: 'https://evil.example' }), 'stitchavenue.in'));
check('origin: absent allowed', originAllowed(headers({}), 'stitchavenue.in'));
check('origin: bad referer refused', !originAllowed(headers({ referer: 'https://evil.example/x' }), 'stitchavenue.in'));

check('fingerprint is stable', fingerprint({ phoneRaw: '+919876543210', name: 'A', notes: 'n', service: 'other' })
  === fingerprint({ phoneRaw: '+919876543210', name: 'a', notes: 'N', service: 'other' }));
check('ipKey is pseudonymous', !ipKey('203.0.113.9').includes('203.0.113.9'));

/* -------------------------------- token ----------------------------- */
console.log('\n=== form token ===');
// Stub the Blobs-backed nonce store so the token logic can be tested alone.
const burned = new Set();
const storeModule = await import('./store.mjs');
const realBurn = storeModule.burnNonce;
const { issue, verify, TokenResult } = await import('./formToken.mjs');

// formToken imported burnNonce by binding, so exercise the pure paths only.
const token = issue();
const parts = token.split('.');
check('token has three parts', parts.length === 3, String(parts.length));
check('nonce is 24 hex chars', /^[0-9a-f]{24}$/.test(parts[1]), parts[1]);

const malformed = await verify('nonsense').catch(() => ({ reason: 'threw' }));
check('malformed rejected', malformed.reason === TokenResult.MALFORMED, malformed.reason);

const tampered = await verify(`${parts[0]}.${parts[1]}.AAAAdeadbeef`).catch(() => ({ reason: 'threw' }));
check('tampered signature rejected', tampered.reason === TokenResult.BAD_SIGNATURE, tampered.reason);

const fresh = await verify(token).catch((e) => ({ reason: `threw:${e.message}` }));
check('fresh token is too fast', fresh.reason === TokenResult.TOO_FAST, fresh.reason);
check('burnNonce is exported', typeof realBurn === 'function');
check('store exposes rate limiter', typeof storeModule.recordAttempt === 'function');

/* -------------------------------- mailer ---------------------------- */
console.log('\n=== mailer: real templates via jsonTransport ===');
process.env.MAIL_TRANSPORT = 'json';
const { send } = await import('./mailer.mjs');

// Hostile input that the validator would normally have refused. The mailer is
// the last line before customer data reaches a header or an HTML body, so it
// is checked here on the assumption every earlier layer failed.
const data = {
  name: 'Meera <script>alert(1)</script> Nair',
  phone: '+91 98765 43210',
  phoneRaw: '+919876543210',
  email: 'meera@example.com',
  service: 'bridal-occasion',
  serviceLabel: 'Bridal / occasion wear',
  date: '2026-09-01',
  dateHuman: 'Tue, 1 Sep 2026',
  notes: 'Reception gown.\nBudget <= ₹25,000 & "gold work".\n<img src=x onerror=alert(1)>',
};

const result = await send(data, { ip: '203.0.113.9' });
const notice = JSON.parse(result.notification.message);
const ack = JSON.parse(result.acknowledgement.message);

check('notification sent', result.notified);
check('acknowledgement sent', result.acknowledged);
check('to is the boutique', notice.to?.[0]?.address === 'boutique@example.com', notice.to?.[0]?.address);
check('from is the SMTP account', notice.from?.address === 'sender@example.com', notice.from?.address);
check('reply-to is the customer', notice.replyTo?.[0]?.address === 'meera@example.com');

check('subject is a single line', !/[\r\n]/.test(notice.subject), JSON.stringify(notice.subject));
check('script tags stripped from display name', !notice.subject.includes('<script>'), notice.subject);
check('angle brackets gone from reply-to name',
  !/[<>]/.test(notice.replyTo?.[0]?.name ?? ''), notice.replyTo?.[0]?.name);

check('script escaped in HTML body', notice.html.includes('&lt;script&gt;'));
check('no live script tag in HTML body', !notice.html.includes('<script>'));
check('no live img/onerror in HTML body', !notice.html.includes('<img src=x'));
check('quotes escaped in notes', notice.html.includes('&quot;gold work&quot;'));
check('ampersand escaped', notice.html.includes('&amp;'));
check('text part carries no HTML', !notice.text.includes('<td'));
check('text part has the phone', notice.text.includes('+91 98765 43210'));
check('rupee symbol survives', notice.text.includes('₹25,000'));

check('ack addressed to the customer', ack.to?.[0]?.address === 'meera@example.com');
check('ack reply-to is the boutique', ack.replyTo?.[0]?.address === 'boutique@example.com');
check('ack greets by first name only', ack.html.includes('Thank you, Meera'), '');
check('ack has no live script', !ack.html.includes('<script>'));

// A blank email must skip the acknowledgement rather than throw.
const noEmail = await send({ ...data, email: undefined }, { ip: '203.0.113.9' });
check('no email -> no acknowledgement', noEmail.acknowledged === false);
check('no email -> notification still sent', noEmail.notified);
check('no email -> Email row shows a dash',
  JSON.parse(noEmail.notification.message).text.includes('—'));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
