<?php
/**
 * Gmail SMTP delivery for booking enquiries.
 *
 * Two messages go out per accepted submission:
 *   · a notification to the boutique, with Reply-To set to the customer
 *   · an acknowledgement to the customer, if they gave an address
 *
 * The acknowledgement is best-effort — a customer who never receives it has
 * still had their enquiry delivered, so its failure must not fail the request.
 */
declare(strict_types=1);

defined('APP_ROOT') || exit;

use PHPMailer\PHPMailer\Exception as MailException;
use PHPMailer\PHPMailer\PHPMailer;

final class Mailer
{
    /**
     * @param  array<string,string> $data Validated, normalised form data
     * @return array{notified: bool, acknowledged: bool}
     * @throws \RuntimeException when the boutique notification cannot be sent
     */
    public static function send(array $data, array $meta = []): array
    {
        self::sendNotification($data, $meta);

        $acknowledged = false;
        if (($data['email'] ?? '') !== '' && config('autoreply.enabled', true)) {
            try {
                self::sendAcknowledgement($data);
                $acknowledged = true;
            } catch (\Throwable $e) {
                app_log('errors', ['event' => 'autoreply_failed', 'error' => $e->getMessage()]);
            }
        }

        return ['notified' => true, 'acknowledged' => $acknowledged];
    }

    /* ------------------------------------------------------------------ */

    private static function sendNotification(array $d, array $meta): void
    {
        $mail = self::transport();

        foreach ((array) config('to', []) as $recipient) {
            $mail->addAddress($recipient['email'], $recipient['name'] ?? '');
        }

        // Only the internal notification carries CC/BCC — see the note in the
        // Netlify mailer for why the customer's acknowledgement must not.
        // A bad address here is skipped rather than allowed to fail the send.
        foreach (['cc' => 'addCC', 'bcc' => 'addBCC'] as $key => $method) {
            foreach ((array) config($key, []) as $recipient) {
                try {
                    $mail->{$method}($recipient['email'], $recipient['name'] ?? '');
                } catch (MailException $e) {
                    app_log('errors', [
                        'event'   => $key . '_rejected',
                        'address' => $recipient['email'] ?? '(missing)',
                        'error'   => $e->getMessage(),
                    ]);
                }
            }
        }

        // Reply-To is the one place customer input reaches a header. The
        // address is validated by now and PHPMailer throws on a malformed one
        // — but a rejected Reply-To must not cost the boutique the enquiry,
        // so it is logged and dropped rather than allowed to fail the send.
        if (($d['email'] ?? '') !== '') {
            try {
                $mail->addReplyTo($d['email'], self::displayName($d['name']));
            } catch (MailException $e) {
                app_log('errors', ['event' => 'replyto_rejected', 'error' => $e->getMessage()]);
            }
        }

        $mail->Subject = self::headerSafe(sprintf(
            'New fitting request — %s (%s)',
            self::displayName($d['name']),
            $d['service_label']
        ));

        $rows = [
            'Name'           => $d['name'],
            'Phone'          => $d['phone'],
            'Email'          => $d['email'] ?? '—',
            'Service'        => $d['service_label'],
            'Preferred date' => $d['date_human'] ?? 'Not specified',
        ];

        $mail->isHTML(true);
        $mail->Body    = self::notificationHtml($rows, $d['notes'] ?? '', $meta);
        $mail->AltBody = self::notificationText($rows, $d['notes'] ?? '', $meta);

        try {
            $mail->send();
        } catch (MailException $e) {
            throw new \RuntimeException($mail->ErrorInfo ?: $e->getMessage(), 0, $e);
        }
    }

    private static function sendAcknowledgement(array $d): void
    {
        $mail = self::transport();
        $mail->addAddress($d['email'], self::displayName($d['name']));

        foreach ((array) config('to', []) as $recipient) {
            $mail->addReplyTo($recipient['email'], $recipient['name'] ?? '');
            break;
        }

        $mail->Subject = self::headerSafe((string) config(
            'autoreply.subject',
            'We have your request — Stitch Avenue Boutique'
        ));

        $mail->isHTML(true);
        $mail->Body    = self::acknowledgementHtml($d);
        $mail->AltBody = self::acknowledgementText($d);
        $mail->send();
    }

    private static function transport(): PHPMailer
    {
        $mail = new PHPMailer(true);

        $mail->isSMTP();
        $mail->Host       = (string) config('smtp.host', 'smtp.gmail.com');
        $mail->Port       = (int) config('smtp.port', 587);
        $mail->SMTPAuth   = true;
        $mail->Username   = (string) config('smtp.username');
        // Google prints app passwords in groups of four; the spaces are display
        // only and the SMTP AUTH will fail if they are sent.
        $mail->Password   = str_replace(' ', '', (string) config('smtp.password'));
        $mail->SMTPSecure = config('smtp.encryption', 'tls') === 'ssl'
            ? PHPMailer::ENCRYPTION_SMTPS
            : PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Timeout    = (int) config('smtp.timeout', 20);
        $mail->CharSet    = PHPMailer::CHARSET_UTF8;
        $mail->Encoding   = PHPMailer::ENCODING_BASE64;
        $mail->XMailer    = ' ';   // don't advertise the library version

        if (config('debug', false)) {
            $mail->SMTPDebug   = 2;
            $mail->Debugoutput = static function (string $line): void {
                app_log('smtp', ['line' => rtrim($line)]);
            };
        }

        $mail->setFrom(
            (string) config('from.email', config('smtp.username')),
            (string) config('from.name', 'Website')
        );

        return $mail;
    }

    /** Subjects are headers: fold anything that could start a new one. */
    private static function headerSafe(string $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', $value) ?? '');
    }

    /**
     * A name safe to sit in an address header. Validator has already refused
     * these characters, but the display name is the one value that lands in a
     * header un-escaped, so it is stripped again here rather than trusted.
     */
    private static function displayName(string $value): string
    {
        $value = preg_replace('/[<>"\\\\\r\n,;:@()\[\]]/u', ' ', $value) ?? '';

        return mb_substr(self::headerSafe($value), 0, 60);
    }

    private static function e(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /* ---------------------------- templates --------------------------- */

    private static function notificationHtml(array $rows, string $notes, array $meta): string
    {
        $cells = '';
        foreach ($rows as $label => $value) {
            $cells .= '<tr>'
                . '<td style="padding:10px 16px;border-bottom:1px solid #ECEAF5;color:#6A6685;'
                . 'font:500 12px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;'
                . 'white-space:nowrap;vertical-align:top">' . self::e((string) $label) . '</td>'
                . '<td style="padding:10px 16px;border-bottom:1px solid #ECEAF5;color:#1B1733;'
                . 'font:400 15px/1.5 Arial,sans-serif">' . self::e((string) $value) . '</td>'
                . '</tr>';
        }

        $notesBlock = $notes === '' ? '' :
            '<h3 style="margin:26px 0 8px;font:600 14px/1.4 Arial,sans-serif;color:#342B6E;'
            . 'letter-spacing:.08em;text-transform:uppercase">Their message</h3>'
            . '<div style="background:#F8F7FC;border-left:3px solid #C9A227;padding:14px 18px;'
            . 'color:#1B1733;font:400 15px/1.6 Arial,sans-serif;white-space:pre-wrap">'
            . self::e($notes) . '</div>';

        $footer = self::e(sprintf(
            'Received %s · %s',
            date('D, j M Y \a\t g:i A'),
            $meta['ip'] ?? 'unknown origin'
        ));

        return '<!doctype html><html><body style="margin:0;background:#F8F7FC;padding:24px">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;'
            . 'background:#fff;border:1px solid #ECEAF5;border-radius:12px;overflow:hidden">'
            . '<tr><td style="background:#342B6E;padding:22px 26px">'
            . '<div style="color:#E3CB86;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.22em;'
            . 'text-transform:uppercase">Stitch Avenue Boutique</div>'
            . '<div style="color:#fff;font:600 22px/1.3 Georgia,serif;margin-top:6px">New fitting request</div>'
            . '</td></tr>'
            . '<tr><td style="padding:22px 10px 6px">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' . $cells . '</table>'
            . '</td></tr>'
            . '<tr><td style="padding:0 26px 26px">' . $notesBlock
            . '<p style="margin:26px 0 0;color:#9A96AE;font:400 12px/1.5 Arial,sans-serif;'
            . 'border-top:1px solid #ECEAF5;padding-top:14px">' . $footer . '</p>'
            . '</td></tr></table></body></html>';
    }

    private static function notificationText(array $rows, string $notes, array $meta): string
    {
        $lines = ['NEW FITTING REQUEST — Stitch Avenue Boutique', str_repeat('-', 46)];
        foreach ($rows as $label => $value) {
            $lines[] = str_pad((string) $label . ':', 17) . $value;
        }
        if ($notes !== '') {
            $lines[] = '';
            $lines[] = 'Their message:';
            $lines[] = $notes;
        }
        $lines[] = '';
        $lines[] = str_repeat('-', 46);
        $lines[] = 'Received ' . date('D, j M Y \a\t g:i A') . ' · ' . ($meta['ip'] ?? 'unknown origin');

        return implode("\n", $lines);
    }

    private static function acknowledgementHtml(array $d): string
    {
        $business = (array) config('business', []);
        $first    = self::e(explode(' ', $d['name'])[0]);
        $when     = isset($d['date_human'])
            ? 'You asked about <strong>' . self::e($d['date_human']) . '</strong>, and we will confirm whether that slot is free.'
            : 'We will call you to fix a time that suits you.';

        return '<!doctype html><html><body style="margin:0;background:#F8F7FC;padding:24px">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;'
            . 'background:#fff;border:1px solid #ECEAF5;border-radius:12px;overflow:hidden">'
            . '<tr><td style="background:#342B6E;padding:26px;text-align:center">'
            . '<div style="color:#E3CB86;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.22em;'
            . 'text-transform:uppercase">Stitch Avenue Boutique</div>'
            . '<div style="color:#fff;font:600 24px/1.3 Georgia,serif;margin-top:8px">Thank you, ' . $first . '</div>'
            . '</td></tr>'
            . '<tr><td style="padding:28px 30px;color:#1B1733;font:400 15px/1.7 Arial,sans-serif">'
            . '<p style="margin:0 0 14px">We have your request for <strong>'
            . self::e($d['service_label']) . '</strong>. ' . $when . '</p>'
            . '<p style="margin:0 0 14px">We reply the same day during shop hours. If it is urgent, '
            . 'calling is quickest — <a href="tel:' . self::e(str_replace(' ', '', (string) ($business['phone'] ?? '')))
            . '" style="color:#342B6E;font-weight:bold">' . self::e((string) ($business['phone'] ?? '')) . '</a>.</p>'
            . '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 0;background:#F8F7FC;'
            . 'border-left:3px solid #C9A227;width:100%"><tr><td style="padding:14px 18px;color:#6A6685;'
            . 'font:400 14px/1.7 Arial,sans-serif">'
            . self::e((string) ($business['address'] ?? '')) . '<br>'
            . self::e((string) ($business['hours'] ?? ''))
            . '</td></tr></table>'
            . '<p style="margin:22px 0 0;color:#9A96AE;font:400 12px/1.5 Arial,sans-serif">'
            . 'This is an automatic acknowledgement — you can reply to it and we will read it.</p>'
            . '</td></tr></table></body></html>';
    }

    private static function acknowledgementText(array $d): string
    {
        $business = (array) config('business', []);

        return implode("\n", array_filter([
            'Thank you, ' . explode(' ', $d['name'])[0] . '.',
            '',
            'We have your request for ' . $d['service_label'] . '.',
            isset($d['date_human'])
                ? 'You asked about ' . $d['date_human'] . ' — we will confirm whether that slot is free.'
                : 'We will call you to fix a time that suits you.',
            '',
            'We reply the same day during shop hours. If it is urgent, please call '
                . ($business['phone'] ?? '') . '.',
            '',
            (string) ($business['address'] ?? ''),
            (string) ($business['hours'] ?? ''),
            '',
            '— ' . ($business['name'] ?? 'Stitch Avenue Boutique'),
        ], static fn($line) => $line !== null));
    }
}
