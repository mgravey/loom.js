export type BrowserExecutionErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PROJECT'
  | 'UNSUPPORTED_COMMAND'
  | 'RUNTIME_LOAD_FAILED'
  | 'EXECUTION_FAILED'
  | 'TIMED_OUT'
  | 'DISPOSED'
  | 'WORKSPACE_SYNC_FAILED';

export class BrowserExecutionError extends Error {
  public readonly code: BrowserExecutionErrorCode;

  public constructor(code: BrowserExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrowserExecutionError';
    this.code = code;
  }
}
