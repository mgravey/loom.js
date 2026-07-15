export type IndexedDbStorageErrorCode =
  | 'STORAGE_CLOSED'
  | 'OPEN_FAILED'
  | 'OPEN_BLOCKED'
  | 'SCHEMA_FAILED'
  | 'REQUEST_FAILED'
  | 'TRANSACTION_FAILED'
  | 'INVALID_DATA';

export class IndexedDbStorageError extends Error {
  public readonly code: IndexedDbStorageErrorCode;
  public readonly operation: string;

  public constructor(
    code: IndexedDbStorageErrorCode,
    operation: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'IndexedDbStorageError';
    this.code = code;
    this.operation = operation;
  }
}
