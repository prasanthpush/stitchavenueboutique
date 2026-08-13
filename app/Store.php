<?php
/**
 * Tiny file-backed state store for the form guards.
 *
 * Everything the anti-spam layer needs to remember between requests lives in
 * one JSON file, mutated under an exclusive lock so two simultaneous posts
 * cannot both slip past the rate limiter.
 *
 * Shape:
 *   {
 *     "ips":          { "<ip key>": [unix ts, ...] },
 *     "global":       [unix ts, ...],
 *     "nonces":       { "<nonce>": expires_at },
 *     "fingerprints": { "<hash>":  expires_at }
 *   }
 */
declare(strict_types=1);

defined('APP_ROOT') || exit;

final class Store
{
    private const EMPTY = ['ips' => [], 'global' => [], 'nonces' => [], 'fingerprints' => []];

    /**
     * Read-modify-write the state under an exclusive lock.
     *
     * @param  callable(array): array{0: array, 1: mixed} $mutator
     *         Receives the current state, returns [new state, return value].
     * @return mixed The mutator's return value.
     */
    public static function transaction(callable $mutator): mixed
    {
        $file = storage_path('guard.json');

        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            // Storage is unwritable. Fail closed: the caller treats a null
            // result as "cannot verify", which blocks the submission rather
            // than silently disabling every rate limit.
            app_log('errors', ['event' => 'store_open_failed', 'file' => $file]);
            return null;
        }

        try {
            if (!flock($handle, LOCK_EX)) {
                app_log('errors', ['event' => 'store_lock_failed']);
                return null;
            }

            $raw   = stream_get_contents($handle);
            $state = self::decode($raw);
            $state = self::prune($state);

            [$state, $result] = $mutator($state);

            $encoded = json_encode($state, JSON_UNESCAPED_SLASHES);
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, $encoded === false ? '{}' : $encoded);
            fflush($handle);

            return $result;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    private static function decode(string $raw): array
    {
        $data = json_decode(trim($raw) === '' ? '{}' : $raw, true);
        if (!is_array($data)) {
            $data = [];
        }
        foreach (self::EMPTY as $key => $default) {
            if (!isset($data[$key]) || !is_array($data[$key])) {
                $data[$key] = $default;
            }
        }
        return $data;
    }

    /** Drop everything that has aged out so the file cannot grow without bound. */
    private static function prune(array $state): array
    {
        $now       = now();
        $dayAgo    = $now - 86400;
        $hourAgo   = $now - 3600;

        foreach ($state['ips'] as $key => $stamps) {
            $kept = array_values(array_filter(
                is_array($stamps) ? $stamps : [],
                static fn($ts) => is_int($ts) && $ts > $dayAgo
            ));
            if ($kept === []) {
                unset($state['ips'][$key]);
            } else {
                $state['ips'][$key] = $kept;
            }
        }

        $state['global'] = array_values(array_filter(
            $state['global'],
            static fn($ts) => is_int($ts) && $ts > $hourAgo
        ));

        foreach (['nonces', 'fingerprints'] as $bucket) {
            foreach ($state[$bucket] as $key => $expiresAt) {
                if (!is_int($expiresAt) || $expiresAt <= $now) {
                    unset($state[$bucket][$key]);
                }
            }
        }

        return $state;
    }
}
