export type CodexExperimentalModelErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'PROVIDER_ERROR';

/** Sanitized failure: access tokens, endpoints, and provider response bodies are never exposed. */
export class CodexExperimentalModelError extends Error {
  public readonly code: CodexExperimentalModelErrorCode;
  public readonly status: number | undefined;

  public constructor(
    code: CodexExperimentalModelErrorCode,
    message: string,
    options: { readonly status?: number } = {},
  ) {
    super(message);
    this.name = 'CodexExperimentalModelError';
    this.code = code;
    this.status = options.status;
  }
}
