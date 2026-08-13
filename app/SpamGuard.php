<?php
/**
 * Layered anti-spam for the booking form.
 *
 * No single check is decisive. A bot has to get past all of them:
 *
 *   1. Origin      — a stated Origin/Referer must be one of our hostnames.
 *   2. Honeypots   — two decoy fields, hidden from people, must stay empty.
 *   3. Token       — signed, single-use, and older than min_fill_seconds
 *                    (handled by FormToken, called from the endpoint).
 *   4. Rate limits — per IP per window, per IP per day, and site-wide per hour.
 *   5. Content     — a score built from link spam, keyword spam, shouting,
 *                    wrong-script text and other tells; over threshold is out.
 *   6. Duplicates  — the same enquiry twice inside ten minutes is dropped.
 */
declare(strict_types=1);

defined('APP_ROOT') || exit;

final class SpamGuard
{
    /** Decoy inputs. Real people never see them, so a value means a bot. */
    public const HONEYPOTS = ['website', 'company'];

    private const DUPLICATE_WINDOW = 600;

    /** Matches a bare host or a full URL anywhere in the text. */
    private const LINK_PATTERN =
        '~(?:https?://)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|in|co|uk|ru|cn|de|xyz|top|club|info|online|site|shop|store|biz|link|icu|live|me|io|be)\b(?:/\S*)?~i';

    /** Places a customer might genuinely link a reference photo from. */
    private const LINK_ALLOWLIST = [
        'instagram.com', 'pinterest.com', 'pin.it', 'facebook.com', 'fb.com',
        'wa.me', 'drive.google.com', 'photos.app.goo.gl', 'youtube.com', 'youtu.be',
        'stitchavenue.in',
    ];

    /**
     * Phrases that never appear in a genuine boutique enquiry. Weighted:
     * 3 is instantly fatal at the default threshold, 1–2 needs corroboration.
     */
    private const KEYWORDS = [
        3 => [
            'seo service', 'seo expert', 'backlink', 'link building', 'guest post',
            'rank higher', 'first page of google', 'increase your traffic',
            'crypto', 'bitcoin', 'forex', 'binary option', 'casino', 'betting',
            'viagra', 'cialis', 'payday loan', 'make money online',
            'work from home', 'nude', 'porn', 'escort', 'sexy girls',
        ],
        2 => [
            'digital marketing', 'web design service', 'website development service',
            'mobile app development', 'lead generation', 'bulk sms', 'bulk email',
            'unsubscribe', 'this is not spam', 'limited time offer', 'act now',
            'dear sir/madam', 'dear webmaster', 'to the owner of',
        ],
        1 => [
            'click here', 'buy now', 'free trial', 'no obligation', 'best price',
            'earn money', 'investment opportunity', 'business proposal',
        ],
    ];

    /* ------------------------- 1. Origin ------------------------- */

    /**
     * A cross-site POST is rejected. A request that states no origin at all is
     * allowed through — some browsers omit both headers on same-origin posts —
     * because the signed token still has to be present and valid.
     */
    public static function originAllowed(): bool
    {
        $allowed = array_map('strtolower', (array) config('security.allowed_hosts', []));
        $allowed[] = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));

        foreach (['HTTP_ORIGIN', 'HTTP_REFERER'] as $header) {
            $value = $_SERVER[$header] ?? '';
            if ($value === '') {
                continue;
            }
            $host = strtolower((string) parse_url((string) $value, PHP_URL_HOST));
            if ($host === '' || !in_array($host, $allowed, true)) {
                return false;
            }
        }
        return true;
    }

    /* ------------------------ 2. Honeypots ----------------------- */

    /** @param array<string,mixed> $input */
    public static function honeypotTripped(array $input): bool
    {
        foreach (self::HONEYPOTS as $field) {
            $value = $input[$field] ?? '';
            if (!is_string($value) || trim($value) !== '') {
                return true;
            }
        }
        return false;
    }

    /* ---------------------- 4. Rate limiting --------------------- */

    /**
     * Records this attempt and reports whether it is over any limit.
     *
     * @return array{allowed: bool, reason: string, retry_after: int}
     */
    public static function rateLimit(string $ip): array
    {
        $key      = ip_key($ip);
        $window   = (int) config('rate_limit.per_ip_window', 900);
        $perIp    = (int) config('rate_limit.per_ip_max', 3);
        $perDay   = (int) config('rate_limit.per_ip_day_max', 8);
        $perHour  = (int) config('rate_limit.global_hour_max', 60);

        $result = Store::transaction(
            static function (array $state) use ($key, $window, $perIp, $perDay, $perHour) {
                $now    = now();
                $stamps = $state['ips'][$key] ?? [];

                $inWindow = array_values(array_filter($stamps, static fn($ts) => $ts > $now - $window));

                if (count($inWindow) >= $perIp) {
                    $retry = $window - ($now - min($inWindow));
                    return [$state, ['allowed' => false, 'reason' => 'ip_window', 'retry_after' => max(30, $retry)]];
                }
                if (count($stamps) >= $perDay) {
                    return [$state, ['allowed' => false, 'reason' => 'ip_day', 'retry_after' => 3600]];
                }
                if (count($state['global']) >= $perHour) {
                    return [$state, ['allowed' => false, 'reason' => 'global_hour', 'retry_after' => 900]];
                }

                $stamps[]          = $now;
                $state['ips'][$key] = $stamps;
                $state['global'][]  = $now;

                return [$state, ['allowed' => true, 'reason' => '', 'retry_after' => 0]];
            }
        );

        // Storage failure — fail closed rather than run with no limiter at all.
        return $result ?? ['allowed' => false, 'reason' => 'store_unavailable', 'retry_after' => 60];
    }

    /* ------------------------ 5. Content ------------------------- */

    /**
     * @param  array<string,string> $clean Output of Validator::clean()
     * @return array{score: int, reasons: string[]}
     */
    public static function score(array $clean): array
    {
        $name  = $clean['name'] ?? '';
        $notes = $clean['notes'] ?? '';
        // The e-mail address is deliberately left out of this blob: its domain
        // would read as a link, and "gmail.com" is not a spam signal.
        $blob  = mb_strtolower(trim($name . "\n" . $notes));

        $score   = 0;
        $reasons = [];

        $add = static function (int $points, string $why) use (&$score, &$reasons): void {
            $score += $points;
            $reasons[] = $why;
        };

        // Links. Customers do sometimes paste one reference picture, so a
        // single link to a place designs actually live is free; anything else
        // is scored, and two or more is fatal on its own.
        $unsolicited = 0;
        if (preg_match_all(self::LINK_PATTERN, $blob, $matches)) {
            foreach ($matches[0] as $hit) {
                $host = strtolower(ltrim(preg_replace('~^https?://~', '', trim($hit)) ?? '', '/'));
                $host = strtok($host, '/?#') ?: $host;
                $host = preg_replace('~^www\.~', '', $host) ?? $host;

                if (!in_array($host, self::LINK_ALLOWLIST, true)) {
                    $unsolicited++;
                }
            }
        }
        if ($unsolicited > 0) {
            $add($unsolicited >= 2 ? 4 : 2, "link:{$unsolicited}");
        }

        // Markup or BBCode — a person typing into a textarea does not use either.
        if (preg_match('~<\s*[a-z!/]|\[/?(?:url|link|b|i)\b~i', $blob)) {
            $add(3, 'markup');
        }

        // Mail headers pasted into the body: a header-injection attempt.
        if (preg_match('/^\s*(bcc|cc|to|from|content-type|mime-version)\s*:/im', $blob)) {
            $add(4, 'header_injection');
        }

        foreach (self::KEYWORDS as $weight => $phrases) {
            foreach ($phrases as $phrase) {
                if (str_contains($blob, $phrase)) {
                    $add($weight, 'kw:' . $phrase);
                    break; // one hit per weight band is enough
                }
            }
        }

        // Cyrillic is the usual giveaway for the automated stuff. Tamil,
        // Devanagari and other Indic scripts are of course perfectly normal here.
        if (preg_match('/\p{Cyrillic}/u', $blob)) {
            $add(3, 'cyrillic');
        }

        if ($notes !== '') {
            $letters = preg_match_all('/\p{L}/u', $notes);
            $upper   = preg_match_all('/\p{Lu}/u', $notes);
            if ($letters > 40 && $upper / max(1, $letters) > 0.7) {
                $add(2, 'shouting');
            }
            // Keyboard mashing / filler: the same character nine times over.
            if (preg_match('/(.)\1{8,}/u', $notes)) {
                $add(2, 'repetition');
            }
            if (mb_substr_count($notes, '@') > 2) {
                $add(2, 'many_addresses');
            }
        }

        // A name that is really a sentence, or a name repeated as the message.
        if (mb_strlen($name) > 0 && $notes !== '' && mb_strtolower($name) === mb_strtolower($notes)) {
            $add(2, 'name_equals_notes');
        }

        return ['score' => $score, 'reasons' => $reasons];
    }

    /* ----------------------- 6. Duplicates ----------------------- */

    /** True when this exact enquiry already arrived in the last ten minutes. */
    public static function isDuplicate(array $clean): bool
    {
        $fingerprint = hash_hmac(
            'sha256',
            implode('|', [
                $clean['phone_raw'] ?? '',
                mb_strtolower($clean['name'] ?? ''),
                mb_strtolower($clean['notes'] ?? ''),
                $clean['service'] ?? '',
            ]),
            (string) config('security.secret')
        );

        $isNew = Store::transaction(static function (array $state) use ($fingerprint) {
            if (isset($state['fingerprints'][$fingerprint])) {
                return [$state, false];
            }
            $state['fingerprints'][$fingerprint] = now() + self::DUPLICATE_WINDOW;
            return [$state, true];
        });

        // Storage failure: let it through. A missed duplicate is a duplicate
        // e-mail; a false positive silently loses a real customer.
        return $isNew === false;
    }
}
