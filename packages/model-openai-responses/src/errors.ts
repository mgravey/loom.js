export type OpenAIResponsesModelErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'INCOMPLETE_RESPONSE'
  | 'PROVIDER_ERROR';

/** Sanitized failure: credentials and provider response bodies are never exposed. */
export class OpenAIResponsesModelError extends Error {
  public readonly code: OpenAIResponsesModelErrorCode;
  public readonly status: number | undefined;

  public constructor(
    code: OpenAIResponsesModelErrorCode,
    message: string,
    options: { readonly status?: number } = {},
  ) {
    super(message);
    this.name = 'OpenAIResponsesModelError';
    this.code = code;
    this.status = options.status;
  }
}
