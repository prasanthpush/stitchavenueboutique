<?php
/**
 * Stitch Avenue Boutique — mail & form configuration.
 *
 * Copy this file to `config/mail.php` and fill in the real values.
 * `config/mail.php` is git-ignored so credentials never reach the repository.
 *
 * ------------------------------------------------------------------
 * GMAIL SETUP (App Password — the only method Gmail still allows)
 * ------------------------------------------------------------------
 * 1. Sign in to the Gmail account that will SEND the mail.
 * 2. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification
 * 3. Create an App Password:      https://myaccount.google.com/apppasswords
 *      App: "Mail"  ·  Device: "Other" → "Stitch Avenue Website"
 * 4. Google shows a 16-character password like `abcd efgh ijkl mnop`.
 *    Paste it below — spaces are stripped automatically.
 * 5. Your normal Gmail password will NOT work here. Neither will an
 *    account without 2-Step Verification enabled.
 *
 * Gmail sending limit: ~500 messages/day on a free account.
 * ------------------------------------------------------------------
 */

return [

    /* ---------------- SMTP transport ---------------- */
    'smtp' => [
        'host'       => 'smtp.gmail.com',
        // 587 + 'tls' (STARTTLS) is the most firewall-friendly.
        // Use 465 + 'ssl' if your host blocks 587.
        'port'       => 587,
        'encryption' => 'tls',
        'username'   => 'your-account@gmail.com',
        'password'   => 'PASTE APP PASSWORD HERE',
        'timeout'    => 20,
    ],

    /* ---------------- Envelope ---------------- */
    // Gmail rewrites the From address to the authenticated account unless
    // the address is a verified "Send mail as" alias, so keep this equal to
    // smtp.username unless you have set up an alias.
    'from' => [
        'email' => 'your-account@gmail.com',
        'name'  => 'Stitch Avenue Website',
    ],

    // Where enquiries land. Add more entries to notify several people.
    'to' => [
        ['email' => 'stitchavenueboutique@gmail.com', 'name' => 'Stitch Avenue Boutique'],
    ],

    // Copied on every enquiry notification. CC is visible to all
    // recipients; BCC is not. Neither appears on the customer's auto-reply.
    'cc'  => [],
    'bcc' => [],

    /* ---------------- Customer auto-reply ---------------- */
    'autoreply' => [
        'enabled' => true,
        'subject' => 'We have your request — Stitch Avenue Boutique',
    ],

    /* ---------------- Business details used in mail ---------------- */
    'business' => [
        'name'     => 'Stitch Avenue Boutique',
        'phone'    => '+91 70949 51438',
        'whatsapp' => 'https://wa.me/917094951438',
        'address'  => 'No. 48A, Sathya Avenue, Mamallan Nagar, Kanchipuram, Tamil Nadu',
        'hours'    => 'Monday – Saturday, 10:00 AM – 8:30 PM',
        'timezone' => 'Asia/Kolkata',
    ],

    /* ---------------- Form security ---------------- */
    'security' => [
        // Signs the one-time form tokens. Generate your own with:
        //   php -r "echo bin2hex(random_bytes(32));"
        'secret' => 'CHANGE-ME-TO-A-64-CHARACTER-RANDOM-HEX-STRING',

        // A human cannot fill this form faster than this (seconds).
        'min_fill_seconds' => 4,

        // A token stops being accepted after this many seconds.
        'token_ttl' => 7200,

        // Hostnames allowed to post to the form. A request whose Origin or
        // Referer names any other host is rejected. Add your live domain.
        'allowed_hosts' => [
            'localhost',
            '127.0.0.1',
            'stitchavenue.in',
            'www.stitchavenue.in',
        ],

        // Reject e-mail addresses whose domain has no MX/A record.
        'verify_email_domain' => true,

        // Only enable behind a proxy/CDN you control (Cloudflare, nginx).
        // When false, the rate limiter trusts REMOTE_ADDR only.
        'trust_proxy' => false,

        // A submission is rejected once its spam score reaches this.
        'spam_threshold' => 3,
    ],

    /* ---------------- Rate limiting ---------------- */
    'rate_limit' => [
        'per_ip_window'   => 900,   // seconds
        'per_ip_max'      => 3,     // submissions per window, per IP
        'per_ip_day_max'  => 8,     // submissions per 24h, per IP
        'global_hour_max' => 60,    // submissions per hour, whole site
    ],

    // true = show SMTP conversation + real error text in the JSON response.
    // NEVER leave this on for a live site.
    'debug' => false,
];
