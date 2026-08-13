# Deploying to Netlify

The booking form runs as two Netlify Functions. Netlify cannot execute PHP, so
the `app/`, `api/`, `config/` and `vendor/` folders are inert here — they are
kept only for the XAMPP setup described in [SETUP.md](SETUP.md), and
`netlify.toml` returns 404 for every one of their URLs so the source is never
served.

```
netlify/functions/form-token.mjs   →  GET  /api/form-token
netlify/functions/book.mjs         →  POST /api/book
netlify/lib/*.mjs                  →  shared validation, anti-spam, mail
```

---

## 1. Set the environment variables

**This is the step that makes the form work.** Netlify → your site → **Site
configuration → Environment variables**. Nothing here belongs in the repo.

| Variable | Required | Value |
|---|---|---|
| `SMTP_USER` | yes | The Gmail address that sends the mail |
| `SMTP_PASS` | yes | Its 16-character Google App Password |
| `FORM_SECRET` | yes | Random 64-character hex — signs the form tokens |
| `MAIL_TO` | yes | Where enquiries land. Comma-separated for several people |
| `MAIL_CC` | no | Copied on the enquiry, visible to all recipients |
| `MAIL_BCC` | no | Copied on the enquiry, hidden from other recipients |
| `ALLOWED_HOSTS` | yes | Your hostnames, comma-separated |
| `MAIL_FROM_NAME` | no | Display name on outgoing mail |
| `SPAM_THRESHOLD` | no | Score at which a message is refused (default `3`) |
| `RATE_IP_MAX` | no | Submissions per 15 min per IP (default `3`) |
| `AUTOREPLY` | no | `off` disables the customer acknowledgement |
| `VERIFY_EMAIL_DOMAIN` | no | `off` skips the MX/A lookup on the customer's domain |
| `DEBUG` | no | `on` returns the real error text in the JSON response |

Generate the secret:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Recipients

`MAIL_TO`, `MAIL_CC` and `MAIL_BCC` all take comma-separated addresses:

```
MAIL_TO=owner@gmail.com,shop@gmail.com
MAIL_CC=manager@gmail.com
MAIL_BCC=archive@gmail.com
```

They apply to the **enquiry notification only**. The customer's acknowledgement
is never copied to anyone — a CC would hand your colleague's address to the
customer, and a BCC would send their enquiry to someone they never agreed to.

An address that is not a valid e-mail is dropped and logged rather than allowed
to fail the whole send, so one typo in `MAIL_CC` cannot cost you an enquiry.
Check the function log for `[config]` lines if a recipient is not receiving.

`ALLOWED_HOSTS` **must include the domain the site is actually served from**,
including the `*.netlify.app` subdomain if you use it:

```
ALLOWED_HOSTS=stitchavenue.in,www.stitchavenue.in,stitchavenue.netlify.app
```

Get this wrong and every submission is refused with *"This form can only be
used from our website."* It is the most likely reason a working local form
breaks once deployed.

### The Gmail App Password

Gmail no longer accepts a normal password over SMTP.

1. Sign in as the account named in `SMTP_USER`
2. Turn on 2-Step Verification →
   <https://myaccount.google.com/signinoptions/two-step-verification>
3. Create an App Password → <https://myaccount.google.com/apppasswords>
   (App: Mail · Device: Other → `Stitch Avenue Website`)
4. Paste the 16 characters into `SMTP_PASS`. Spaces are stripped automatically.

**App Passwords are tied to the account that generated them.** Changing
`SMTP_USER` to a different Gmail account means generating a new one — the old
password will not work.

`from` always tracks `SMTP_USER`, because Gmail rewrites the From header to the
authenticated account unless the address is a verified "Send mail as" alias.

---

## 2. Deploy

Push to `main`; Netlify builds from `netlify.toml`. There is no build step for
the site itself — `publish = "."` serves the repo root, and functions are
bundled with esbuild.

Netlify Blobs (used for rate-limit counters and spent tokens) needs no setup;
it is provisioned automatically for the site.

---

## 3. Local development

```
cp .env.example .env      # then fill it in
npm install
npm run dev               # netlify dev on http://localhost:8888
```

`netlify dev` serves the static site, runs the functions and provides a local
Blobs store, so the whole chain works offline. `.env` is git-ignored.

Run the logic tests without starting a server:

```
npm test
```

---

## 4. Where the logs are

The PHP version wrote files under `storage/logs/`. Functions log to Netlify
instead: **site → Logs → Functions**, or `netlify logs:function book`.

| Prefix | Meaning |
|---|---|
| `[submission]` | An accepted enquiry |
| `[rejected]` | Refused, with the exact layer that refused it |
| `[send_failed]` | Gmail delivery failed — **includes the full enquiry**, so nothing is lost |
| `[not_configured]` | A required environment variable is missing |

---

## 5. What changed from the PHP version

The rules are identical — same validation, same six anti-spam layers, same
emails. Two things differ because serverless has no filesystem:

- **Rate-limit state lives in Netlify Blobs**, one key per IP rather than one
  locked file. Blobs offer no locking, so two submissions hitting the same key
  in the same few milliseconds can both be counted as the first. The effect is
  that an occasional fourth submission slips past a 3-per-window limit. That is
  an accepted trade: closing it would need a transactional store, and the
  consequence is one extra enquiry e-mail.
- **Logs go to Netlify's function log** rather than files on disk. They are
  retained per your Netlify plan rather than forever.

---

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| *"This form can only be used from our website."* | Domain missing from `ALLOWED_HOSTS` |
| *"The form is not connected yet."* | A required env var is unset — check the function log for `[not_configured]` |
| *"We could not send that just now."* | Gmail rejected the login. Usually a wrong App Password, or `SMTP_USER` changed without generating a new one |
| *"We could not reach the server."* | The fetch never got a response — the function is not deployed, or the site is being served somewhere without functions |
| 404 on `/api/book` | Functions did not deploy. Check the deploy log for a bundling error |
| Everything refused with 429 | Rate limit. Expected while testing from one IP — see `RATE_IP_MAX` |

Turn on `DEBUG=on` to get the real SMTP error text in the response, and **turn
it off again afterwards**.
