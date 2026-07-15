import type { WorkspacePath } from '@loom/tool-workspace';

export type FileSystemAccessWorkspaceErrorCode =
  | 'INVALID_ROOT'
  | 'ENTRY_NOT_FOUND'
  | 'EXPECTED_DIRECTORY'
  | 'EXPECTED_FILE'
  | 'LIST_FAILED'
  | 'READ_FAILED'
  | 'WRITE_FAILED';

export class FileSystemAccessWorkspaceError extends Error {
  public readonly code: FileSystemAccessWorkspaceErrorCode;
  public readonly path: WorkspacePath | undefined;

  public constructor(
    code: FileSystemAccessWorkspaceErrorCode,
    message: string,
    options: { readonly path?: WorkspacePath; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'FileSystemAccessWorkspaceError';
    this.code = code;
    this.path = options.path;
  }
}
