# Stitch Avenue Boutique

Marketing site for Stitch Avenue Boutique — custom stitching and boutique wear
in Kanchipuram.

A static single-page site plus a small PHP backend that handles the booking
form and sends enquiries over Gmail SMTP.

## Running it locally

Serve the folder with XAMPP (or any PHP 8.1+ server) and open it:

```
php -S 127.0.0.1:8000
```

The form needs PHP. Opening `index.html` straight off the filesystem will render
the page but the booking form will not send.

## Booking form

**The form needs a Google App Password before it can send mail.**
See [SETUP.md](SETUP.md) — that is the only outstanding step, and it also covers
the anti-spam layers, validation rules, logs and troubleshooting.

## Layout

```
index.html          the page
assets/css/         styles
assets/js/          navigation, scroll reveals, form handling
assets/images/web/  optimised WebP images
api/                form endpoints
app/                validation, anti-spam and mail
config/             settings (config/mail.php is git-ignored)
```
