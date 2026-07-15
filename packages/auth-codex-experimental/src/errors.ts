export type CodexExperimentalAuthErrorCode =
  | 'EXPERIMENT_DISABLED'
  | 'DEVICE_AUTH_UNAVAILABLE'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_TIMEOUT'
  | 'INVALID_CALLBACK'
  | 'INVALID_STATE'
  | 'INVALID_PKCE'
  | 'INVALID_RESPONSE'
  | 'TEMPORARY_FAILURE';

/** A sanitized experimental-auth failure. Provider response bodies are never exposed. */
export class CodexExperimentalAuthError extends Error {
  public readonly code: CodexExperimentalAuthErrorCode;

  public constructor(
    code: CodexExperimentalAuthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexExperimentalAuthError';
    this.code = code;
  }
}
