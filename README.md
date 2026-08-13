# Stitch Avenue Boutique

Marketing site for Stitch Avenue Boutique — custom stitching and boutique wear
in Kanchipuram.

A static single-page site plus a booking form that validates strictly, filters
spam in six layers, and sends enquiries over Gmail SMTP.

## The form has two backends

The same rules and the same emails, implemented twice for two hosts:

| Backend | Runs on | Setup guide |
|---|---|---|
| **Netlify Functions** (JavaScript) | The live site | [NETLIFY.md](NETLIFY.md) |
| **PHP** | Local XAMPP | [SETUP.md](SETUP.md) |

The live site is on Netlify, which cannot execute PHP — so the Netlify Function
is the one that actually serves customers. The PHP version is kept for the XAMPP
setup and as a ready-made option if the site ever moves to PHP hosting.

## Running it locally

```
npm install
cp .env.example .env     # fill in SMTP_USER, SMTP_PASS, FORM_SECRET, MAIL_TO
npm run dev              # http://localhost:8888
```

`npm test` runs the validation, anti-spam and mail-template checks without
needing a server or credentials.

## Layout

```
index.html            the page
assets/css/           styles
assets/js/            navigation, scroll reveals, form handling
assets/images/web/    optimised WebP images

netlify/functions/    the live form endpoints
netlify/lib/          validation, anti-spam, mail (shared by both functions)
netlify.toml          publish settings, redirects, security headers

api/  app/  config/   the PHP backend — XAMPP only, never served on Netlify
vendor/               PHPMailer (PHP backend only)
```
