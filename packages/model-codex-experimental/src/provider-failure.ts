export const CODEX_PROVIDER_CODE_MAXIMUM_LENGTH = 256;
export const CODEX_PROVIDER_MESSAGE_MAXIMUM_LENGTH = 512;
export const CODEX_RETRY_AFTER_MAXIMUM_MS = 24 * 60 * 60 * 1_000;
export const GENERIC_CODEX_PROVIDER_MESSAGE = 'The provider rejected the request.';

const NON_RETRYABLE_CODE_FRAGMENTS = [
  'account',
  'auth',
  'billing',
  'credit',
  'forbidden',
  'insufficient_quota',
  'invalid',
  'payment',
  'permission',
  'policy',
  'quota_exceeded',
  'restricted',
  'unauthorized',
] as const;

const RETRYABLE_PROVIDER_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'service_unavailable',
]);

function withoutControlCharacters(value: string): string {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character;
  }
  return sanitized;
}

/** Accept a short provider identifier without forwarding arbitrary structured values. */
export function boundedCodexProviderString(
  value: unknown,
  maximumLength = CODEX_PROVIDER_CODE_MAXIMUM_LENGTH,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized === '' ||
    normalized.length > maximumLength ||
    !/^[a-zA-Z0-9._:[\]-]+$/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * Produce a short display-safe provider message. This helper accepts only the selected message
 * field, never an error envelope or response body.
 */
export function sanitizeCodexProviderMessage(value: unknown): string {
  if (typeof value !== 'string') return GENERIC_CODEX_PROVIDER_MESSAGE;
  const withoutControls = withoutControlCharacters(
    value.slice(0, CODEX_PROVIDER_MESSAGE_MAXIMUM_LENGTH * 4),
  );
  const redacted = withoutControls
    .replaceAll(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replaceAll(/\bsk-[a-z0-9_-]{8,}\b/giu, '[REDACTED]')
    .replaceAll(
      /("?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)"?\s*:\s*")[^"]*"/giu,
      '$1[REDACTED]"',
    )
    .replaceAll(
      /('?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)'?\s*:\s*')[^']*'/giu,
      "$1[REDACTED]'",
    )
    .replaceAll(/\b(cookie|set-cookie|authorization)\b\s*[:=]\s*.+$/giu, '$1: [REDACTED]')
    .replaceAll(
      /\b(api[-_ ]?key|authorization|cookie|set-cookie|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)\b(\s*[:=]\s*|"\s*:\s*")[^,\s;"'}]+/giu,
      '$1$2[REDACTED]',
    )
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (redacted === '') return GENERIC_CODEX_PROVIDER_MESSAGE;
  return redacted.slice(0, CODEX_PROVIDER_MESSAGE_MAXIMUM_LENGTH);
}

export function validCodexRetryAfterMs(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= CODEX_RETRY_AFTER_MAXIMUM_MS
    ? value
    : undefined;
}

export function isRetryableProviderFailure(status?: number, providerCode?: string): boolean {
  const normalizedCode = providerCode?.trim().toLowerCase();
  if (
    normalizedCode !== undefined &&
    NON_RETRYABLE_CODE_FRAGMENTS.some((fragment) => normalizedCode.includes(fragment))
  ) {
    return false;
  }
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }
  return RETRYABLE_PROVIDER_CODES.has(normalizedCode ?? '');
}
