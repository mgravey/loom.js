import { OpenAIResponsesModelError } from '@mgravey/loom-model-openai-responses';

/**
 * Stable recovery categories. Hosts branch on `kind`, never on message text.
 *
 * Provider-specific categories follow OpenAI's documented Sign in with ChatGPT recovery table.
 */
export type ChatGPTBrowserErrorKind =
  /** The page origin or browser cannot run the documented loopback flow. */
  | 'unsupported-environment'
  /** The user or host cancelled, the popup closed, or the attempt expired. */
  | 'sign-in-cancelled'
  /** The browser blocked the sign-in popup. Retry from a user gesture. */
  | 'popup-blocked'
  /** The callback, token response, or registration could not be accepted. Start a fresh sign-in. */
  | 'sign-in-failed'
  /** The signed identity could not be verified. Start a fresh sign-in. */
  | 'identity-verification-failed'
  /** A model call was attempted without an active session. */
  | 'not-signed-in'
  /** The account is signed in but `chatgpt.tokens.use.direct` was not granted. */
  | 'plan-not-granted'
  /** Confirmed unusable session (terminal refresh error or identity change). Sign in again. */
  | 'reauthentication-required'
  /** Client registration, grant, or route configuration was rejected. Do not retry unchanged. */
  | 'client-configuration'
  /** `subscription_sharing_usage_limit_exceeded`. Pause plan requests and offer "Manage usage". */
  | 'usage-limit-reached'
  /** `subscription_sharing_user_not_eligible`. Explain; do not retry or loop through OAuth. */
  | 'user-not-eligible'
  /** Temporary provider or network unavailability. Keep credentials and retry with backoff. */
  | 'temporarily-unavailable'
  /** `subscription_sharing_unsupported_capability`. Remove the unsupported input or feature. */
  | 'unsupported-capability'
  /** The provider rejected the current credential without a confirmed terminal error. */
  | 'credential-rejected'
  /** A provider policy check (for example serving region) blocked admission. */
  | 'access-denied'
  /** Browser metadata storage is unavailable. */
  | 'storage-unavailable'
  /** The provider returned a malformed, oversized, or incomplete response. */
  | 'invalid-response'
  /** The provider rejected the request for another reason. */
  | 'request-failed'
  /** The caller cancelled the request, the session changed, or the request timed out. */
  | 'cancelled';

/** Documented provider codes that are mapped to stable kinds. Unknown codes are never exposed. */
export type ChatGPTBrowserProviderErrorCode =
  | 'subscription_sharing_user_not_eligible'
  | 'subscription_sharing_usage_limit_exceeded'
  | 'subscription_sharing_usage_unavailable'
  | 'subscription_sharing_unsupported_capability'
  | 'subscription_sharing_route_not_supported'
  | 'subscription_sharing_invalid_user'
  | 'subscription_sharing_user_unavailable'
  | 'chatpass_v2_scope_not_authorized'
  | 'chatpass_v2_invalid_authorization_context';

/** Documented refresh-token error codes. */
export type ChatGPTBrowserTokenErrorCode =
  | 'invalid_grant'
  | 'invalid_refresh_token'
  | 'token_expired'
  | 'refresh_token_expired'
  | 'refresh_token_invalidated'
  | 'refresh_token_reused'
  | 'invalid_client';

export interface ChatGPTBrowserErrorOptions {
  readonly status?: number;
  readonly invalidatesSession?: boolean;
  readonly tokenErrorCode?: ChatGPTBrowserTokenErrorCode;
  readonly providerCode?: ChatGPTBrowserProviderErrorCode;
  readonly requestId?: string;
  readonly retryable?: boolean;
}

const RETRYABLE_KINDS: ReadonlySet<ChatGPTBrowserErrorKind> = new Set(['temporarily-unavailable']);

/**
 * Sanitized failure. Messages are authored locally; provider bodies, OAuth codes, URLs, tokens,
 * and underlying exceptions are never attached as a message, property, or cause.
 */
export class ChatGPTBrowserError extends OpenAIResponsesModelError {
  public readonly kind: ChatGPTBrowserErrorKind;
  /** True when the in-memory session was cleared because it is confirmed unusable. */
  public readonly invalidatesSession: boolean;
  public readonly tokenErrorCode: ChatGPTBrowserTokenErrorCode | undefined;
  public readonly providerCode: ChatGPTBrowserProviderErrorCode | undefined;
  /** Provider request identifier (format-checked) for support diagnostics. */
  public readonly requestId: string | undefined;
  /** True only when the same request may be retried later with bounded backoff. */
  public readonly retryable: boolean;

  public constructor(
    kind: ChatGPTBrowserErrorKind,
    message: string,
    options: ChatGPTBrowserErrorOptions = {},
  ) {
    super(
      'PROVIDER_ERROR',
      message,
      options.status === undefined ? {} : { status: options.status },
    );
    this.name = 'ChatGPTBrowserError';
    this.kind = kind;
    this.invalidatesSession = options.invalidatesSession ?? false;
    this.tokenErrorCode = options.tokenErrorCode;
    this.providerCode = options.providerCode;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(kind);
  }
}

export function chatgptError(
  kind: ChatGPTBrowserErrorKind,
  message: string,
  options?: ChatGPTBrowserErrorOptions,
): ChatGPTBrowserError {
  return new ChatGPTBrowserError(kind, message, options);
}

const PROVIDER_CODES: Readonly<
  Record<
    ChatGPTBrowserProviderErrorCode,
    { readonly kind: ChatGPTBrowserErrorKind; readonly message: string }
  >
> = Object.freeze({
  subscription_sharing_user_not_eligible: {
    kind: 'user-not-eligible',
    message: 'This ChatGPT account is not eligible to use its plan in this app.',
  },
  subscription_sharing_usage_limit_exceeded: {
    kind: 'usage-limit-reached',
    message:
      'Usage limit reached. Review your plan or this app’s limit in ChatGPT settings (Manage usage).',
  },
  subscription_sharing_usage_unavailable: {
    kind: 'temporarily-unavailable',
    message:
      'ChatGPT plan usage is temporarily unavailable. Your session is retained; retry later.',
  },
  subscription_sharing_user_unavailable: {
    kind: 'temporarily-unavailable',
    message:
      'ChatGPT is temporarily unavailable for this account. Your session is retained; retry later.',
  },
  subscription_sharing_unsupported_capability: {
    kind: 'unsupported-capability',
    message:
      'ChatGPT plan usage does not support a requested input, tool, feature, or model. Remove it and try again.',
  },
  subscription_sharing_route_not_supported: {
    kind: 'client-configuration',
    message: 'ChatGPT plan usage does not support this request route.',
  },
  subscription_sharing_invalid_user: {
    kind: 'credential-rejected',
    message:
      'ChatGPT did not accept this session’s credentials. Your session is retained; sign in again only if this persists.',
  },
  chatpass_v2_scope_not_authorized: {
    kind: 'client-configuration',
    message: 'ChatGPT rejected this app’s grant configuration. Do not retry unchanged.',
  },
  chatpass_v2_invalid_authorization_context: {
    kind: 'client-configuration',
    message: 'ChatGPT rejected this app’s authorization context. Do not retry unchanged.',
  },
});

export function isProviderErrorCode(value: unknown): value is ChatGPTBrowserProviderErrorCode {
  return typeof value === 'string' && Object.hasOwn(PROVIDER_CODES, value);
}

/** Maps an allowlisted provider code (or bare HTTP status) to a sanitized error. */
export function providerError(
  code: ChatGPTBrowserProviderErrorCode | undefined,
  status: number | undefined,
  requestId: string | undefined,
  fallback: string,
): ChatGPTBrowserError {
  const extra = {
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
  };
  if (code !== undefined) {
    const mapped = PROVIDER_CODES[code];
    return new ChatGPTBrowserError(mapped.kind, mapped.message, { ...extra, providerCode: code });
  }
  const suffix = status === undefined ? '' : ` (HTTP ${String(status)})`;
  if (status === 401)
    return new ChatGPTBrowserError(
      'credential-rejected',
      `ChatGPT did not accept the signed identity or plan permission${suffix}. Check the selected account and granted permissions.`,
      extra,
    );
  if (status === 403)
    return new ChatGPTBrowserError(
      'access-denied',
      `A ChatGPT policy check blocked this request${suffix}.`,
      extra,
    );
  if (status === 429 || (status !== undefined && status >= 500))
    return new ChatGPTBrowserError(
      'temporarily-unavailable',
      `ChatGPT is temporarily unavailable${suffix}. Your session is retained; retry later.`,
      extra,
    );
  return new ChatGPTBrowserError('request-failed', `${fallback}${suffix}.`, extra);
}
