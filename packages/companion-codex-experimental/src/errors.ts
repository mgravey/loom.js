export type CodexCompanionErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'EXTENSION_UNAVAILABLE'
  | 'ORIGIN_ACCESS_FAILED'
  | 'ORIGIN_APPROVAL_REQUIRED'
  | 'CONNECTION_FAILED'
  | 'INVALID_RESPONSE'
  | 'EXTENSION_REQUEST_FAILED'
  | 'CANCELLED';

/** Sanitized website-side transport failure; provider response bodies and credentials are excluded. */
export class CodexCompanionError extends Error {
  public readonly code: CodexCompanionErrorCode;
  public readonly remoteCode: string | undefined;
  public readonly operation: 'generate' | 'compact' | undefined;
  public readonly requestId: string | undefined;
  public readonly stage: string | undefined;
  public readonly status: number | undefined;

  public constructor(
    code: CodexCompanionErrorCode,
    message: string,
    options: {
      readonly remoteCode?: string;
      readonly status?: number;
      readonly operation?: 'generate' | 'compact';
      readonly requestId?: string;
      readonly stage?: string;
    } = {},
  ) {
    super(message);
    this.name = 'CodexCompanionError';
    this.code = code;
    this.remoteCode = options.remoteCode;
    this.status = options.status;
    this.operation = options.operation;
    this.requestId = options.requestId;
    this.stage = options.stage;
  }
}
