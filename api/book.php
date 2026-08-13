<?php
/**
 * Booking-form endpoint.
 *
 * Checks run cheapest-first, so an obvious bot is turned away before we spend
 * a DNS lookup or an SMTP connection on it:
 *
 *   method → size → origin → honeypot → token/timing → rate limit
 *          → field validation → spam score → duplicate → send
 *
 * Every rejection is logged with its real reason; the caller only ever sees a
 * generic message, so a bot cannot use the response to work out which layer it
 * tripped and iterate against it.
 */
declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';
require APP_ROOT . '/app/Store.php';
require APP_ROOT . '/app/FormToken.php';
require APP_ROOT . '/app/Validator.php';
require APP_ROOT . '/app/SpamGuard.php';
require APP_ROOT . '/app/Mailer.php';

const MAX_BODY_BYTES = 8192;

$ip    = client_ip();
$phone = (string) config('business.phone', '+91 70949 51438');

/** Log the real reason, answer with something bland. */
function reject(int $status, string $reason, string $message, array $extra = []): never
{
    app_log('rejected', ['reason' => $reason, 'ip' => client_ip(), 'status' => $status] + $extra);
    json_response($status, ['ok' => false, 'message' => $message]);
}

/* ----------------------------- 0. Transport ---------------------------- */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_response(405, ['ok' => false, 'message' => 'Method not allowed.']);
}

if (config_is_placeholder()) {
    app_log('errors', ['event' => 'not_configured']);
    json_response(503, [
        'ok'      => false,
        'message' => 'The form is not connected yet. Please call us on ' . $phone . '.',
    ]);
}

if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY_BYTES) {
    reject(413, 'body_too_large', 'That message is too long. Please shorten it and try again.');
}

$contentType = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
if (!str_contains($contentType, 'application/x-www-form-urlencoded')) {
    reject(415, 'bad_content_type', 'We could not read that submission. Please reload the page and try again.');
}

/* ------------------------------ 1. Origin ------------------------------ */

if (!SpamGuard::originAllowed()) {
    reject(403, 'bad_origin', 'This form can only be used from our website.', [
        'origin'  => $_SERVER['HTTP_ORIGIN'] ?? null,
        'referer' => $_SERVER['HTTP_REFERER'] ?? null,
    ]);
}

/* ----------------------------- 2. Honeypot ----------------------------- */

if (SpamGuard::honeypotTripped($_POST)) {
    reject(422, 'honeypot', 'We could not process that request. Please call us on ' . $phone . '.');
}

/* --------------------------- 3. Token & timing -------------------------- */

$token  = is_string($_POST['form_token'] ?? null) ? $_POST['form_token'] : '';
$verdict = FormToken::verify($token);

if ($verdict['reason'] !== FormToken::OK) {
    $expired = in_array($verdict['reason'], [FormToken::EXPIRED, FormToken::REPLAYED], true);

    reject(
        $expired ? 409 : 403,
        'token_' . $verdict['reason'],
        $expired
            ? 'This form has been open a while. Please reload the page and send it again.'
            : 'We could not verify that submission. Please reload the page and try again.',
        ['age' => $verdict['age']]
    );
}

/* ---------------------------- 4. Rate limiting -------------------------- */

$limit = SpamGuard::rateLimit($ip);
if (!$limit['allowed']) {
    header('Retry-After: ' . $limit['retry_after']);
    reject(429, 'rate_' . $limit['reason'],
        'You have already sent us a few requests. Please give us a little time to reply, '
        . 'or call ' . $phone . '.');
}

/* --------------------------- 5. Field validation ------------------------ */

$validator = new Validator();
if (!$validator->validate($_POST)) {
    app_log('rejected', ['reason' => 'validation', 'ip' => $ip, 'fields' => array_keys($validator->errors())]);
    json_response(422, [
        'ok'      => false,
        'message' => 'Please check the highlighted fields.',
        'errors'  => $validator->errors(),
    ]);
}

$clean = $validator->clean();

/* ----------------------------- 6. Spam score ---------------------------- */

$spam = SpamGuard::score($clean);
if ($spam['score'] >= (int) config('security.spam_threshold', 3)) {
    reject(422, 'spam_content',
        'We could not process that message. If this is a genuine enquiry, please call us on ' . $phone . '.',
        ['score' => $spam['score'], 'signals' => $spam['reasons']]);
}

/* ------------------------------ 7. Duplicate ---------------------------- */

if (SpamGuard::isDuplicate($clean)) {
    json_response(200, [
        'ok'      => true,
        'message' => 'We already have this request — no need to send it twice. We will be in touch shortly.',
    ]);
}

/* -------------------------------- 8. Send ------------------------------- */

try {
    $result = Mailer::send($clean, ['ip' => $ip]);
} catch (\Throwable $e) {
    app_log('errors', [
        'event'   => 'send_failed',
        'ip'      => $ip,
        'error'   => $e->getMessage(),
        'enquiry' => [
            'name'    => $clean['name'],
            'phone'   => $clean['phone'],
            'email'   => $clean['email'] ?? null,
            'service' => $clean['service_label'],
            'date'    => $clean['date'] ?? null,
            'notes'   => $clean['notes'] ?? null,
        ],
    ]);

    json_response(500, [
        'ok'      => false,
        'message' => 'We could not send that just now. Please call or WhatsApp us on ' . $phone . '.',
        'detail'  => config('debug', false) ? $e->getMessage() : null,
    ]);
}

app_log('submissions', [
    'ip'           => $ip,
    'name'         => $clean['name'],
    'phone'        => $clean['phone'],
    'email'        => $clean['email'] ?? null,
    'service'      => $clean['service_label'],
    'date'         => $clean['date'] ?? null,
    'spam_score'   => $spam['score'],
    'acknowledged' => $result['acknowledged'],
]);

$firstName = explode(' ', $clean['name'])[0];

json_response(200, [
    'ok'      => true,
    'message' => $result['acknowledged']
        ? 'Thank you, ' . $firstName . '. A confirmation is on its way to your inbox — we will call you shortly.'
        : 'Thank you, ' . $firstName . '. We have your request and will call you shortly to confirm your slot.',
]);
