<?php
/**
 * Shared bootstrap for the form endpoints.
 * Loads config, exposes small helpers, and defines APP_ROOT — which every
 * other file in app/ requires before it will do anything.
 */
declare(strict_types=1);

define('APP_ROOT', dirname(__DIR__));

require APP_ROOT . '/vendor/autoload.php';

/**
 * Read a config value with dot notation: config('smtp.host').
 * Returns the whole config array when called with no key.
 */
function config(?string $key = null, mixed $default = null): mixed
{
    static $cfg = null;

    if ($cfg === null) {
        $file = APP_ROOT . '/config/mail.php';
        if (!is_file($file)) {
            fail_hard('Missing config/mail.php — copy config/mail.example.php and fill it in.');
        }
        $cfg = require $file;
        if (!is_array($cfg)) {
            fail_hard('config/mail.php must return an array.');
        }
    }

    if ($key === null) {
        return $cfg;
    }

    $value = $cfg;
    foreach (explode('.', $key) as $segment) {
        if (!is_array($value) || !array_key_exists($segment, $value)) {
            return $default;
        }
        $value = $value[$segment];
    }
    return $value;
}

/** True when the config still holds the shipped placeholder values. */
function config_is_placeholder(): bool
{
    $password = (string) config('smtp.password', '');
    $username = (string) config('smtp.username', '');
    $secret   = (string) config('security.secret', '');

    return $password === '' || str_contains($password, 'PASTE APP PASSWORD')
        || $username === '' || str_contains($username, 'your-account@')
        || $secret === '' || str_starts_with($secret, 'CHANGE-ME');
}

function storage_path(string $relative = ''): string
{
    $dir = APP_ROOT . '/storage';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $relative === '' ? $dir : $dir . '/' . ltrim($relative, '/');
}

/**
 * The caller's IP. Proxy headers are only consulted when the operator has
 * explicitly opted in — otherwise anyone could spoof their way past the
 * rate limiter with a forged X-Forwarded-For.
 */
function client_ip(): string
{
    $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';

    if (!config('security.trust_proxy', false)) {
        return $remote;
    }

    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'] as $header) {
        if (empty($_SERVER[$header])) {
            continue;
        }
        foreach (explode(',', (string) $_SERVER[$header]) as $candidate) {
            $candidate = trim($candidate);
            if (filter_var($candidate, FILTER_VALIDATE_IP)) {
                return $candidate;
            }
        }
    }
    return $remote;
}

/** Pseudonymised IP — enough to rate-limit, not enough to be a stored identifier. */
function ip_key(string $ip): string
{
    return substr(hash_hmac('sha256', $ip, (string) config('security.secret', 'fallback')), 0, 32);
}

function now(): int
{
    return time();
}

/** Emit JSON and stop. Nothing after this runs. */
function json_response(int $status, array $payload): never
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, no-cache, must-revalidate');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Last-resort failure before config is usable. */
function fail_hard(string $message): never
{
    error_log('[stitchavenue] ' . $message);
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode([
        'ok'      => false,
        'message' => 'The form is not set up yet. Please call us on +91 70949 51438.',
    ]);
    exit;
}

/**
 * Append one JSON line to storage/logs/<channel>.log.
 * Logging must never take the request down, so every failure is swallowed.
 */
function app_log(string $channel, array $data): void
{
    try {
        $dir = storage_path('logs');
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        $line = json_encode(
            ['at' => gmdate('c')] + $data,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
        @file_put_contents($dir . '/' . $channel . '.log', $line . PHP_EOL, FILE_APPEND | LOCK_EX);
    } catch (\Throwable) {
        // ignored on purpose
    }
}

date_default_timezone_set((string) config('business.timezone', 'Asia/Kolkata'));
