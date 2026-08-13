# Booking form — the PHP backend (XAMPP)

> **This is not what the live site uses.** The live site runs on Netlify, which
> cannot execute PHP — see [NETLIFY.md](NETLIFY.md) for the deployed backend.
> This guide covers the PHP version, kept for local XAMPP work and as a
> ready-made option if the site ever moves to PHP hosting.
>
> Note the form posts to `/api/book` (the Netlify Function) by default. To use
> the PHP endpoint instead, point the form's `action` back at `api/book.php`
> and the token fetch in `assets/js/main.js` back at `api/form-token.php`.

The form sends the enquiry through **Gmail SMTP** and replies with JSON.
Everything is wired up; there is one thing left to do before it can send mail.

---

## 1. The one required step: a Google App Password

Gmail no longer accepts your normal password over SMTP. You need a 16-character
**App Password**, and Google only offers those on accounts with 2-Step
Verification switched on.

1. Sign in as the Gmail account that will **send** the mail — whichever address
   `smtp.username` is set to in `config/mail.php`
2. Turn on 2-Step Verification →
   <https://myaccount.google.com/signinoptions/two-step-verification>
3. Create the App Password → <https://myaccount.google.com/apppasswords>
   - **App:** Mail
   - **Device:** Other → `Stitch Avenue Website`
4. Google shows something like `abcd efgh ijkl mnop`. Copy it.
5. Open **`config/mail.php`** and replace the placeholder:

   ```php
   'password'   => 'PASTE APP PASSWORD HERE',   // ← put the 16 characters here
   ```

   The spaces do not matter — they are stripped before use.

Until this is done, the form answers every submission with
*"The form is not connected yet. Please call us on +91 70949 51438."*
That is deliberate, so it can never fail silently.

**Gmail sends up to ~500 messages a day on a free account.** Well beyond what
this form will ever generate, but worth knowing.

---

## 2. Before the site goes live

In `config/mail.php`, add the real domain to `security.allowed_hosts`:

```php
'allowed_hosts' => [
    'localhost',
    '127.0.0.1',
    'stitchavenue.in',
    'www.stitchavenue.in',
],
```

A POST whose `Origin`/`Referer` names any other host is refused. Forgetting this
is the single most likely reason for a working local form to break on the live
server.

Also check:

- `config/mail.php` is **not** in git (`.gitignore` already excludes it). It
  holds the password — never commit it.
- `storage/` is writable by the web server. It holds rate-limit counters, spent
  tokens and logs, and is created automatically on first use.
- If port 587 is blocked by the host, switch to `'port' => 465` with
  `'encryption' => 'ssl'`.

---

## 3. What arrives when someone submits

- **To the boutique** — a formatted enquiry with name, phone, email, service,
  preferred date and their message. `Reply-To` is set to the customer, so
  hitting Reply in Gmail writes straight back to them.
- **To the customer** — a short acknowledgement. Email is a required field, so
  this always goes out. Turn it off with `autoreply.enabled => false`.

---

## 4. How the spam filtering works

Six independent layers. A bot has to beat all of them; a real customer never
notices any of them.

| Layer | What it does |
|---|---|
| **Origin check** | A stated `Origin`/`Referer` must be one of `allowed_hosts`. |
| **Honeypots** | Two decoy fields (`website`, `company`) sit off-screen. Any value in either means a bot. |
| **Signed token** | Single-use, HMAC-signed, issued by `api/form-token.php`. Blocks direct POSTs and replays of a captured request. |
| **Time trap** | The token carries its issue time. Anything submitted in under 4 seconds is not a human. |
| **Rate limits** | 3 per 15 minutes and 8 per day per IP, 60 per hour site-wide. |
| **Content score** | Links, SEO/crypto/loan keyword bands, pasted mail headers, HTML, Cyrillic text, shouting and character mashing all add points. 3+ is refused. |

Plus strict field validation (see below) and a 10-minute duplicate check, so a
double-click cannot send the same enquiry twice.

### Tuning

Everything lives under `security` and `rate_limit` in `config/mail.php`.

- Genuine enquiries being refused? Raise `spam_threshold` to `4`.
- Want it harsher? Drop it to `2`, or raise `min_fill_seconds`.
- Behind Cloudflare or an nginx proxy? Set `trust_proxy => true`, otherwise
  every visitor looks like one IP to the rate limiter. **Only** enable this
  behind a proxy you control — otherwise the header can be forged.

### Validation rules

| Field | Rule |
|---|---|
| Name | Required. 2–60 characters, letters only (Tamil and other Indic scripts included) plus `. ' -`. No digits, links or symbols. |
| Phone | Required. Indian mobile: 10 digits starting 6–9, optional `+91`/`91`/`0` prefix. Stored as `+91 XXXXX XXXXX`. |
| Email | Required. Valid address, ≤100 characters, and the domain must actually resolve. |
| Date | Optional. A real calendar date between today and six months out. |
| Service | Must be one of the four listed values. |
| Message | Optional, ≤700 characters. |

The same rules run in the browser (`assets/js/main.js`) for quick feedback and
again on the server, which is the one that counts. **If you change a rule,
change it in both places** — `app/Validator.php` is the authority.

---

## 5. Testing the form

Two guards will get in your way while testing, both by design:

**"You have already sent us a few requests…"** — the rate limit. Testing from
localhost means your browser and any test script share one IP bucket, so three
attempts uses it up. It counts attempts, not successes, so a rejected
submission spends a slot too. Reset it:

```
rm storage/guard.json
```

That clears the counters and the spent-token list. Or raise `per_ip_max`
temporarily — just put it back to `3` before going live.

**"This form has been open a while…"** — the token is single-use. After any
submission the page fetches a fresh one automatically; if you are replaying a
request with `curl`, fetch a new token each time and wait out the four-second
minimum before posting.

---

## 6. Logs

Written as one JSON object per line under `storage/logs/`:

- `submissions.log` — every accepted enquiry
- `rejected.log` — what was refused and exactly which layer refused it
- `errors.log` — SMTP and delivery failures, including the full enquiry so
  nothing is lost when Gmail is unreachable
- `smtp.log` — the SMTP conversation, only when `debug` is on

If mail is not arriving, read `errors.log` first. To see the SMTP handshake, set
`'debug' => true` in `config/mail.php` — **and turn it back off afterwards**, as
it also returns the real error text to the browser.

### Common failures

| Message in the log | Cause |
|---|---|
| `SMTP Error: Could not authenticate` | Wrong App Password, or 2-Step Verification is off. |
| `Could not connect to SMTP host` | Port 587 blocked — try 465 + `ssl`. |
| `bad_origin` in `rejected.log` | Live domain missing from `allowed_hosts`. |
| `store_unavailable` | `storage/` is not writable by the web server. |

---

## 7. Files

```
api/book.php            form endpoint — runs the guard chain, then sends
api/form-token.php      issues the single-use form token
app/bootstrap.php       config loading and shared helpers
app/Validator.php       field rules (the authority)
app/SpamGuard.php       origin, honeypot, rate limit, content score, duplicates
app/FormToken.php       token issue and verification
app/Store.php           locked JSON state for counters and spent tokens
app/Mailer.php          Gmail SMTP delivery and the mail templates
config/mail.php         live settings — git-ignored, holds the password
config/mail.example.php documented template, safe to commit
storage/                counters and logs, created automatically
vendor/                 PHPMailer, installed by Composer
```

`vendor/` is committed so the site can be uploaded by FTP without running
Composer on the server. If you would rather not track it, add `/vendor/` to
`.gitignore` and run `composer install --no-dev` as part of deployment.

Requires PHP 8.1+ with the `openssl` and `mbstring` extensions (XAMPP has both).
