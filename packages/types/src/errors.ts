export type LoomErrorCode =
  | 'INVALID_ID'
  | 'INVALID_VERSION'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_LIFECYCLE_TRANSITION'
  | 'PLUGIN_API_VERSION_MISMATCH'
  | 'DUPLICATE_PLUGIN'
  | 'MISSING_PLUGIN_DEPENDENCY'
  | 'PLUGIN_DEPENDENCY_CYCLE'
  | 'DUPLICATE_CAPABILITY'
  | 'MISSING_CAPABILITY'
  | 'REGISTRATION_CLOSED'
  | 'DUPLICATE_SERVICE'
  | 'MISSING_SERVICE'
  | 'CIRCULAR_SERVICE_DEPENDENCY'
  | 'DUPLICATE_SESSION'
  | 'MISSING_SESSION'
  | 'PLUGIN_INITIALIZATION_FAILED'
  | 'PLUGIN_START_FAILED'
  | 'CLEANUP_FAILED';

export class LoomError extends Error {
  public readonly code: LoomErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: LoomErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LoomError';
    this.code = code;
    this.details = options.details;
  }
}

export class LoomAggregateError extends LoomError {
  public readonly errors: readonly unknown[];

  public constructor(code: LoomErrorCode, message: string, errors: readonly unknown[]) {
    super(code, message, { cause: errors[0] });
    this.name = 'LoomAggregateError';
    this.errors = Object.freeze([...errors]);
  }
}
