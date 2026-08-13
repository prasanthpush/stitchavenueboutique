<?php
/**
 * Issues a single-use token for the booking form.
 *
 * The page itself stays a static .html file, so the token is fetched here on
 * load. Its issue time doubles as the start of the "did a human really spend
 * time filling this in?" clock.
 */
declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';
require APP_ROOT . '/app/Store.php';
require APP_ROOT . '/app/FormToken.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    json_response(405, ['ok' => false, 'message' => 'Method not allowed.']);
}

if (config_is_placeholder()) {
    json_response(503, [
        'ok'      => false,
        'message' => 'The form is not connected yet. Please call us on '
                     . config('business.phone', '+91 70949 51438') . '.',
    ]);
}

json_response(200, [
    'ok'       => true,
    'token'    => FormToken::issue(),
    'min_wait' => (int) config('security.min_fill_seconds', 4),
]);
