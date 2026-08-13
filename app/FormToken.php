<?php
/**
 * One-time, signed form tokens.
 *
 * Stateless by design — the issue time and a random nonce are signed with the
 * server secret, so no session cookie is needed and the page can stay a plain
 * cacheable .html file. The nonce is burned on first use, which turns the
 * token into a single-shot credential: replaying a captured POST fails.
 *
 * Token: <issued at>.<nonce>.<base64url hmac-sha256>
 */
declare(strict_types=1);

defined('APP_ROOT') || exit;

final class FormToken
{
    public const OK              = 'ok';
    public const MALFORMED       = 'malformed';
    public const BAD_SIGNATURE   = 'bad_signature';
    public const EXPIRED         = 'expired';
    public const FROM_THE_FUTURE = 'from_the_future';
    public const TOO_FAST        = 'too_fast';
    public const REPLAYED        = 'replayed';
    public const UNVERIFIABLE    = 'unverifiable';

    public static function issue(): string
    {
        $issuedAt = now();
        $nonce    = bin2hex(random_bytes(12));

        return $issuedAt . '.' . $nonce . '.' . self::sign($issuedAt . '.' . $nonce);
    }

    /**
     * @return array{reason: string, age: int}
     */
    public static function verify(string $token): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return ['reason' => self::MALFORMED, 'age' => 0];
        }

        [$issuedAt, $nonce, $signature] = $parts;

        if (!ctype_digit($issuedAt) || !ctype_xdigit($nonce) || strlen($nonce) !== 24) {
            return ['reason' => self::MALFORMED, 'age' => 0];
        }

        $expected = self::sign($issuedAt . '.' . $nonce);
        if (!hash_equals($expected, $signature)) {
            return ['reason' => self::BAD_SIGNATURE, 'age' => 0];
        }

        $age = now() - (int) $issuedAt;

        // A clock skew of a few seconds is normal; minutes means a forged stamp.
        if ($age < -30) {
            return ['reason' => self::FROM_THE_FUTURE, 'age' => $age];
        }
        if ($age > (int) config('security.token_ttl', 7200)) {
            return ['reason' => self::EXPIRED, 'age' => $age];
        }
        if ($age < (int) config('security.min_fill_seconds', 4)) {
            return ['reason' => self::TOO_FAST, 'age' => $age];
        }

        $burned = self::burnNonce($nonce, (int) $issuedAt);
        if ($burned === null) {
            return ['reason' => self::UNVERIFIABLE, 'age' => $age];
        }
        if ($burned === false) {
            return ['reason' => self::REPLAYED, 'age' => $age];
        }

        return ['reason' => self::OK, 'age' => $age];
    }

    private static function sign(string $payload): string
    {
        $raw = hash_hmac('sha256', $payload, (string) config('security.secret'), true);
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    /**
     * @return bool|null true = first use, false = already used, null = storage failure
     */
    private static function burnNonce(string $nonce, int $issuedAt): ?bool
    {
        return Store::transaction(static function (array $state) use ($nonce, $issuedAt) {
            if (isset($state['nonces'][$nonce])) {
                return [$state, false];
            }
            $state['nonces'][$nonce] = $issuedAt + (int) config('security.token_ttl', 7200);
            return [$state, true];
        });
    }
}
