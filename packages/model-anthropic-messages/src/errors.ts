export type AnthropicMessagesModelErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'INCOMPLETE_RESPONSE'
  | 'REFUSED'
  | 'PROVIDER_ERROR';

/** Documented Claude API error `type` values. Unknown types are never exposed. */
export type AnthropicProviderErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'billing_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'timeout_error'
  | 'overloaded_error';

const PROVIDER_TYPES: ReadonlySet<string> = new Set<AnthropicProviderErrorType>([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
]);
const RETRYABLE_TYPES: ReadonlySet<string> = new Set([
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
]);

export interface AnthropicMessagesModelErrorOptions {
  readonly status?: number;
  readonly providerCode?: AnthropicProviderErrorType;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly stopReason?: string;
  readonly refusalCategory?: string;
  readonly browserAccessDenied?: boolean;
  readonly contextCompactionRequired?: boolean;
}

/**
 * Sanitized failure. Messages are authored locally; API keys, access tokens, provider response
 * bodies, and provider messages are never exposed.
 */
export class AnthropicMessagesModelError extends Error {
  public readonly code: AnthropicMessagesModelErrorCode;
  public readonly status: number | undefined;
  /** Allowlisted Claude API `error.type`. */
  public readonly providerCode: AnthropicProviderErrorType | undefined;
  public readonly retryable: boolean;
  /** Validated `retry-after` delay, capped at 24 hours. */
  public readonly retryAfterMs: number | undefined;
  public readonly requestId: string | undefined;
  public readonly stopReason: string | undefined;
  public readonly refusalCategory: string | undefined;
  /** True when the organization does not allow direct browser (CORS) requests. */
  public readonly browserAccessDenied: boolean;
  public readonly contextCompactionRequired: boolean | undefined;

  public constructor(
    code: AnthropicMessagesModelErrorCode,
    message: string,
    options: AnthropicMessagesModelErrorOptions = {},
  ) {
    super(message);
    this.name = 'AnthropicMessagesModelError';
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.stopReason = options.stopReason;
    this.refusalCategory = options.refusalCategory;
    this.browserAccessDenied = options.browserAccessDenied ?? false;
    this.contextCompactionRequired = options.contextCompactionRequired;
  }
}

export function providerType(value: unknown): AnthropicProviderErrorType | undefined {
  return typeof value === 'string' && PROVIDER_TYPES.has(value)
    ? (value as AnthropicProviderErrorType)
    : undefined;
}

export function retryableFailure(
  status: number | undefined,
  type: AnthropicProviderErrorType | undefined,
): boolean {
  if (type !== undefined) return RETRYABLE_TYPES.has(type);
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CORS_DENIED = 'CORS requests are not allowed for this Organization';
/** Documented `invalid_request_error` wordings for a prompt that exceeds the context window. */
const CONTEXT_WINDOW_EXCEEDED = [
  /^prompt is too long\b/iu,
  /^input length and `?max_tokens`? exceed context limit\b/iu,
];

export interface AnthropicErrorBodyClassification {
  readonly providerCode: AnthropicProviderErrorType | undefined;
  /** True when the organization does not allow direct browser (CORS) requests. */
  readonly browserAccessDenied: boolean;
  /** True when the request exceeds the model context and history must be compacted. */
  readonly contextCompactionRequired: boolean;
}

/**
 * Classifies a parsed Claude API error body. The provider message is only matched against fixed
 * wordings and is never returned.
 */
export function classifyAnthropicErrorBody(
  status: number,
  body: unknown,
): AnthropicErrorBodyClassification {
  const error = record(body) && record(body.error) ? body.error : undefined;
  const providerCode = providerType(error?.type);
  const message = typeof error?.message === 'string' ? error.message : undefined;
  return {
    providerCode,
    browserAccessDenied: status === 401 && message?.startsWith(CORS_DENIED) === true,
    contextCompactionRequired:
      providerCode === 'request_too_large' ||
      (status === 400 &&
        providerCode === 'invalid_request_error' &&
        message !== undefined &&
        CONTEXT_WINDOW_EXCEEDED.some((pattern) => pattern.test(message.trim()))),
  };
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

const MAXIMUM_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
export function safeRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAXIMUM_RETRY_AFTER_MS
    ? value
    : undefined;
}

/** Parses a `retry-after` header (delta seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,9}(?:\.\d+)?$/u.test(trimmed))
    return safeRetryAfter(Math.ceil(Number.parseFloat(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return safeRetryAfter(Math.max(0, date - now));
}
