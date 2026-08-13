<?php
/**
 * Strict server-side validation for the booking form.
 *
 * Nothing that reaches Mailer has been trusted: every field is length-capped,
 * pattern-checked and normalised here first. Single-line fields reject CR/LF
 * outright, which is what closes off SMTP header injection.
 */
declare(strict_types=1);

defined('APP_ROOT') || exit;

final class Validator
{
    /** Form value => human label used in the e-mail. */
    public const SERVICES = [
        'custom-stitching' => 'Custom stitching',
        'boutique-wear'    => 'Boutique wear',
        'bridal-occasion'  => 'Bridal / occasion wear',
        'other'            => 'Something else',
    ];

    private const MAX_NAME  = 60;
    private const MAX_EMAIL = 100;
    private const MAX_NOTES = 700;
    private const MAX_DAYS_AHEAD = 180;

    /** @var array<string,string> */
    private array $errors = [];

    /** @var array<string,string> */
    private array $clean = [];

    /** @param array<string,mixed> $input Raw $_POST */
    public function validate(array $input): bool
    {
        $this->errors = [];
        $this->clean  = [];

        $this->validateName($this->raw($input, 'name'));
        $this->validatePhone($this->raw($input, 'phone'));
        $this->validateEmail($this->raw($input, 'email'));
        $this->validateDate($this->raw($input, 'date'));
        $this->validateService($this->raw($input, 'service'));
        $this->validateNotes($this->raw($input, 'notes'));

        return $this->errors === [];
    }

    /** @return array<string,string> */
    public function errors(): array
    {
        return $this->errors;
    }

    /** @return array<string,string> */
    public function clean(): array
    {
        return $this->clean;
    }

    /* ------------------------------------------------------------------ */

    /**
     * Pull one field as a trimmed string. Anything that is not a scalar
     * (an array smuggled in as `name[]`, say) becomes an empty string.
     */
    private function raw(array $input, string $key): string
    {
        $value = $input[$key] ?? '';
        if (!is_string($value)) {
            return '';
        }
        // Strip C0/C1 controls except tab and newline, then normalise line endings.
        $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';
        $value = str_replace(["\r\n", "\r"], "\n", $value);

        return trim($value);
    }

    /** Collapse runs of whitespace and forbid line breaks — for header-bound fields. */
    private function singleLine(string $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', $value) ?? '');
    }

    private function validateName(string $value): void
    {
        $value = $this->singleLine($value);

        if ($value === '') {
            $this->errors['name'] = 'Please tell us your name.';
            return;
        }
        if (mb_strlen($value) < 2) {
            $this->errors['name'] = 'That name looks too short.';
            return;
        }
        if (mb_strlen($value) > self::MAX_NAME) {
            $this->errors['name'] = 'Please keep the name under ' . self::MAX_NAME . ' characters.';
            return;
        }
        // Letters, marks (Tamil/Devanagari vowel signs), spaces and the few
        // punctuation marks that appear in real names.
        if (!preg_match('/^[\p{L}\p{M}][\p{L}\p{M} .\'\-]*$/u', $value)) {
            $this->errors['name'] = 'Please use letters only — no digits, links or symbols.';
            return;
        }
        if (preg_match_all('/[\p{L}]/u', $value) < 2) {
            $this->errors['name'] = 'Please enter your full name.';
            return;
        }

        $this->clean['name'] = $value;
    }

    /**
     * Indian mobile numbers: ten digits starting 6–9, with an optional
     * +91 / 91 / 0 prefix. Stored normalised so duplicates are easy to spot.
     */
    private function validatePhone(string $value): void
    {
        $digits = preg_replace('/[^0-9+]/', '', $value) ?? '';

        if ($digits === '') {
            $this->errors['phone'] = 'Please give us a phone number.';
            return;
        }

        $digits = ltrim($digits, '+');
        foreach (['91', '0'] as $prefix) {
            if (strlen($digits) > 10 && str_starts_with($digits, $prefix)) {
                $digits = substr($digits, strlen($prefix));
                break;
            }
        }

        if (!preg_match('/^[6-9][0-9]{9}$/', $digits)) {
            $this->errors['phone'] = 'Enter a 10-digit Indian mobile number.';
            return;
        }

        $this->clean['phone']     = '+91 ' . substr($digits, 0, 5) . ' ' . substr($digits, 5);
        $this->clean['phone_raw'] = '+91' . $digits;
    }

    /** Required, and it must be deliverable — we reply and acknowledge to it. */
    private function validateEmail(string $value): void
    {
        $value = $this->singleLine($value);
        if ($value === '') {
            $this->errors['email'] = 'Please give us an email address.';
            return;
        }
        if (mb_strlen($value) > self::MAX_EMAIL) {
            $this->errors['email'] = 'That email address is too long.';
            return;
        }

        $normalised = filter_var($value, FILTER_VALIDATE_EMAIL);
        if ($normalised === false) {
            $this->errors['email'] = 'That email address does not look right.';
            return;
        }

        $at     = strrpos($normalised, '@');
        $domain = strtolower(substr($normalised, $at + 1));

        if (!str_contains($domain, '.') || str_ends_with($domain, '.')) {
            $this->errors['email'] = 'That email address does not look right.';
            return;
        }

        if (config('security.verify_email_domain', true) && function_exists('checkdnsrr')) {
            // Catches typo domains (gmail.con) and the throwaway domains bots
            // invent. Turn `verify_email_domain` off if the host's resolver is
            // unreliable — a dead resolver looks the same as a dead domain here.
            if (!checkdnsrr($domain, 'MX') && !checkdnsrr($domain, 'A')) {
                $this->errors['email'] = 'We could not find that email domain. Please check the spelling.';
                return;
            }
        }

        $this->clean['email'] = substr($normalised, 0, $at) . '@' . $domain;
    }

    /** Optional preferred date: today .. +180 days, and a real calendar date. */
    private function validateDate(string $value): void
    {
        $value = $this->singleLine($value);
        if ($value === '') {
            return;
        }

        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        if ($date === false || $date->format('Y-m-d') !== $value) {
            $this->errors['date'] = 'Please pick a valid date.';
            return;
        }

        $today = new \DateTimeImmutable('today');
        if ($date < $today) {
            $this->errors['date'] = 'Please pick a date that has not passed.';
            return;
        }
        if ($date > $today->modify('+' . self::MAX_DAYS_AHEAD . ' days')) {
            $this->errors['date'] = 'Please pick a date within the next six months.';
            return;
        }

        $this->clean['date']       = $value;
        $this->clean['date_human'] = $date->format('D, j M Y');
    }

    private function validateService(string $value): void
    {
        $value = $this->singleLine($value);

        if (!array_key_exists($value, self::SERVICES)) {
            $this->errors['service'] = 'Please choose one of the listed services.';
            return;
        }

        $this->clean['service']       = $value;
        $this->clean['service_label'] = self::SERVICES[$value];
    }

    private function validateNotes(string $value): void
    {
        if ($value === '') {
            return;
        }
        if (mb_strlen($value) > self::MAX_NOTES) {
            $this->errors['notes'] = 'Please keep this under ' . self::MAX_NOTES . ' characters.';
            return;
        }
        // Collapse runs of blank lines but keep the customer's paragraphing.
        $value = preg_replace('/\n{3,}/', "\n\n", $value) ?? $value;

        $this->clean['notes'] = trim($value);
    }
}
