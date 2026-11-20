export type CodexAgentErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_DEPENDENCIES'
  | 'MALFORMED_MODEL_EVENT'
  | 'UNKNOWN_MODEL_EVENT'
  | 'MALFORMED_TOOL_CALL'
  | 'UNAUTHORIZED_TOOL_CALL'
  | 'UNKNOWN_TOOL_OPERATION'
  | 'COMPACTION_UNAVAILABLE'
  | 'MODEL_FAILURE'
  | 'TOOL_FAILURE'
  | 'MAX_TURNS_EXCEEDED';

export class CodexAgentError extends Error {
  public readonly code: CodexAgentErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  /** Signals that the failed model turn may be resumed only after context compaction. */
  public readonly contextCompactionRequired: boolean | undefined;

  public constructor(
    code: CodexAgentErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly contextCompactionRequired?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CodexAgentError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.contextCompactionRequired = options.contextCompactionRequired;
  }
}
