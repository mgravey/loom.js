export type CodexExperimentalModelErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'PROVIDER_ERROR';

export interface CodexProviderFailureDetails {
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly incompleteReason?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly contextCompactionRequired?: boolean;
}

/** Sanitized failure: access tokens, endpoints, and provider response bodies are never exposed. */
export class CodexExperimentalModelError extends Error {
  public readonly code: CodexExperimentalModelErrorCode;
  public readonly status: number | undefined;
  public readonly providerCode: string | undefined;
  public readonly providerMessage: string | undefined;
  public readonly incompleteReason: string | undefined;
  public readonly retryable: boolean | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly contextCompactionRequired: boolean | undefined;

  public constructor(
    code: CodexExperimentalModelErrorCode,
    message: string,
    options: CodexProviderFailureDetails & { readonly status?: number } = {},
  ) {
    super(message);
    this.name = 'CodexExperimentalModelError';
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage;
    this.incompleteReason = options.incompleteReason;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.contextCompactionRequired = options.contextCompactionRequired;
  }
}
