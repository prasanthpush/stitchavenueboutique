/**
 * Gmail SMTP delivery for booking enquiries.
 *
 * Two messages go out per accepted submission:
 *   · a notification to the boutique, with Reply-To set to the customer
 *   · an acknowledgement to the customer
 *
 * The acknowledgement is best-effort — a customer who never receives it has
 * still had their enquiry delivered, so its failure must not fail the request.
 *
 * A direct port of app/Mailer.php.
 */
import nodemailer from 'nodemailer';

import { config } from './config.mjs';

let transporter = null;

function transport() {
  if (!transporter) {
    // MAIL_TRANSPORT=json builds the full MIME message and returns it instead
    // of connecting. Used by the self-test; never set in a deployed context.
    if (process.env.MAIL_TRANSPORT === 'json') {
      transporter = nodemailer.createTransport({ jsonTransport: true });
      return transporter;
    }

    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS.
      secure: config.smtp.port === 465,
      requireTLS: config.smtp.port !== 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 25000,
    });
  }
  return transporter;
}

/** Verify credentials without sending anything. */
export async function verifyConnection() {
  return transport().verify();
}

/** Headers are line-oriented: fold anything that could start a new one. */
const headerSafe = (value) => value.replace(/\s+/gu, ' ').trim();

/**
 * A name safe to sit in an address header. The validator has already refused
 * these characters, but the display name is the one value that lands in a
 * header un-escaped, so it is stripped again here rather than trusted.
 */
const displayName = (value) =>
  headerSafe(value.replace(/[<>"\\\r\n,;:@()[\]]/gu, ' ')).slice(0, 60);

const e = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const stamp = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: config.business.timezone,
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());

/**
 * @param  {Record<string,string>} d Validated, normalised form data
 * @return {Promise<{notified: boolean, acknowledged: boolean}>}
 * @throws when the boutique notification cannot be sent
 */
export async function send(d, meta = {}) {
  const notification = await sendNotification(d, meta);

  let acknowledged = false;
  let acknowledgement = null;
  if (d.email && config.autoreply.enabled) {
    try {
      acknowledgement = await sendAcknowledgement(d);
      acknowledged = true;
    } catch (error) {
      console.error('[autoreply_failed]', error?.message ?? error);
    }
  }

  return { notified: true, acknowledged, notification, acknowledgement };
}

async function sendNotification(d, meta) {
  const rows = {
    Name: d.name,
    Phone: d.phone,
    Email: d.email ?? '—',
    Service: d.serviceLabel,
    'Preferred date': d.dateHuman ?? 'Not specified',
  };

  const message = {
    from: { name: config.from.name, address: config.from.email },
    to: config.to,
    subject: headerSafe(`New fitting request — ${displayName(d.name)} (${d.serviceLabel})`),
    html: notificationHtml(rows, d.notes ?? '', meta),
    text: notificationText(rows, d.notes ?? '', meta),
  };

  // Reply-To is the one place customer input reaches a header. The address is
  // validated by now; nodemailer refuses a malformed one, and a rejected
  // Reply-To must not cost the boutique the enquiry.
  if (d.email) {
    message.replyTo = { name: displayName(d.name), address: d.email };
  }

  return transport().sendMail(message);
}

async function sendAcknowledgement(d) {
  return transport().sendMail({
    from: { name: config.from.name, address: config.from.email },
    to: { name: displayName(d.name), address: d.email },
    replyTo: config.to[0],
    subject: headerSafe(config.autoreply.subject),
    html: acknowledgementHtml(d),
    text: acknowledgementText(d),
  });
}

/* ---------------------------- templates --------------------------- */

function notificationHtml(rows, notes, meta) {
  const cells = Object.entries(rows).map(([label, value]) =>
    '<tr>'
    + '<td style="padding:10px 16px;border-bottom:1px solid #ECEAF5;color:#6A6685;'
    + 'font:500 12px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;'
    + `white-space:nowrap;vertical-align:top">${e(label)}</td>`
    + '<td style="padding:10px 16px;border-bottom:1px solid #ECEAF5;color:#1B1733;'
    + `font:400 15px/1.5 Arial,sans-serif">${e(value)}</td>`
    + '</tr>').join('');

  const notesBlock = notes === '' ? '' :
    '<h3 style="margin:26px 0 8px;font:600 14px/1.4 Arial,sans-serif;color:#342B6E;'
    + 'letter-spacing:.08em;text-transform:uppercase">Their message</h3>'
    + '<div style="background:#F8F7FC;border-left:3px solid #C9A227;padding:14px 18px;'
    + 'color:#1B1733;font:400 15px/1.6 Arial,sans-serif;white-space:pre-wrap">'
    + `${e(notes)}</div>`;

  const footer = e(`Received ${stamp()} · ${meta.ip ?? 'unknown origin'}`);

  return '<!doctype html><html><body style="margin:0;background:#F8F7FC;padding:24px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;'
    + 'background:#fff;border:1px solid #ECEAF5;border-radius:12px;overflow:hidden">'
    + '<tr><td style="background:#342B6E;padding:22px 26px">'
    + '<div style="color:#E3CB86;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.22em;'
    + 'text-transform:uppercase">Stitch Avenue Boutique</div>'
    + '<div style="color:#fff;font:600 22px/1.3 Georgia,serif;margin-top:6px">New fitting request</div>'
    + '</td></tr>'
    + '<tr><td style="padding:22px 10px 6px">'
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells}</table>`
    + '</td></tr>'
    + `<tr><td style="padding:0 26px 26px">${notesBlock}`
    + '<p style="margin:26px 0 0;color:#9A96AE;font:400 12px/1.5 Arial,sans-serif;'
    + `border-top:1px solid #ECEAF5;padding-top:14px">${footer}</p>`
    + '</td></tr></table></body></html>';
}

function notificationText(rows, notes, meta) {
  const lines = ['NEW FITTING REQUEST — Stitch Avenue Boutique', '-'.repeat(46)];
  for (const [label, value] of Object.entries(rows)) {
    lines.push(`${label}:`.padEnd(17) + value);
  }
  if (notes !== '') {
    lines.push('', 'Their message:', notes);
  }
  lines.push('', '-'.repeat(46), `Received ${stamp()} · ${meta.ip ?? 'unknown origin'}`);

  return lines.join('\n');
}

function acknowledgementHtml(d) {
  const { business } = config;
  const first = e(d.name.split(' ')[0]);
  const when = d.dateHuman
    ? `You asked about <strong>${e(d.dateHuman)}</strong>, and we will confirm whether that slot is free.`
    : 'We will call you to fix a time that suits you.';

  return '<!doctype html><html><body style="margin:0;background:#F8F7FC;padding:24px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;'
    + 'background:#fff;border:1px solid #ECEAF5;border-radius:12px;overflow:hidden">'
    + '<tr><td style="background:#342B6E;padding:26px;text-align:center">'
    + '<div style="color:#E3CB86;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.22em;'
    + 'text-transform:uppercase">Stitch Avenue Boutique</div>'
    + `<div style="color:#fff;font:600 24px/1.3 Georgia,serif;margin-top:8px">Thank you, ${first}</div>`
    + '</td></tr>'
    + '<tr><td style="padding:28px 30px;color:#1B1733;font:400 15px/1.7 Arial,sans-serif">'
    + `<p style="margin:0 0 14px">We have your request for <strong>${e(d.serviceLabel)}</strong>. ${when}</p>`
    + '<p style="margin:0 0 14px">We reply the same day during shop hours. If it is urgent, '
    + `calling is quickest — <a href="tel:${e(business.phone.replace(/\s/g, ''))}" `
    + `style="color:#342B6E;font-weight:bold">${e(business.phone)}</a>.</p>`
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 0;background:#F8F7FC;'
    + 'border-left:3px solid #C9A227;width:100%"><tr><td style="padding:14px 18px;color:#6A6685;'
    + 'font:400 14px/1.7 Arial,sans-serif">'
    + `${e(business.address)}<br>${e(business.hours)}`
    + '</td></tr></table>'
    + '<p style="margin:22px 0 0;color:#9A96AE;font:400 12px/1.5 Arial,sans-serif">'
    + 'This is an automatic acknowledgement — you can reply to it and we will read it.</p>'
    + '</td></tr></table></body></html>';
}

function acknowledgementText(d) {
  const { business } = config;

  return [
    `Thank you, ${d.name.split(' ')[0]}.`,
    '',
    `We have your request for ${d.serviceLabel}.`,
    d.dateHuman
      ? `You asked about ${d.dateHuman} — we will confirm whether that slot is free.`
      : 'We will call you to fix a time that suits you.',
    '',
    `We reply the same day during shop hours. If it is urgent, please call ${business.phone}.`,
    '',
    business.address,
    business.hours,
    '',
    `— ${business.name}`,
  ].join('\n');
}
