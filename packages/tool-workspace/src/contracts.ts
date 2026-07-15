import type { OperationContext, Tool } from '@loom/plugin-api';

import type { WorkspacePath } from './path.js';

export const WORKSPACE_OPERATIONS = Object.freeze({
  listFiles: 'workspace/list-files',
  readFile: 'workspace/read-file',
  writeFile: 'workspace/write-file',
} as const);

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[keyof typeof WORKSPACE_OPERATIONS];
export type WorkspaceEntryKind = 'file' | 'directory';

export interface WorkspaceEntry {
  readonly path: WorkspacePath;
  readonly kind: WorkspaceEntryKind;
}

/** Omitting `path` lists the immediate entries at the workspace root. */
export interface ListFilesInput {
  readonly path?: WorkspacePath;
}

export interface ListFilesOutput {
  readonly entries: readonly WorkspaceEntry[];
}

export interface ReadFileInput {
  readonly path: WorkspacePath;
}

export interface ReadFileOutput {
  readonly path: WorkspacePath;
  readonly content: string;
}

export interface WriteFileInput {
  readonly path: WorkspacePath;
  readonly content: string;
}

export interface WriteFileOutput {
  readonly path: WorkspacePath;
  readonly created: boolean;
}

export interface ListFilesTool extends Tool<ListFilesInput, ListFilesOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.listFiles;
}

export interface ReadFileTool extends Tool<ReadFileInput, ReadFileOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.readFile;
}

export interface WriteFileTool extends Tool<WriteFileInput, WriteFileOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.writeFile;
}

export type WorkspaceTool = ListFilesTool | ReadFileTool | WriteFileTool;

/**
 * Environment-neutral adapter implemented by an in-memory, browser, OPFS, or
 * other workspace provider. `listFiles` returns only immediate descendants.
 */
export interface TextWorkspace {
  listFiles(
    path: WorkspacePath | undefined,
    context?: OperationContext,
  ): Promise<readonly WorkspaceEntry[]>;
  readFile(path: WorkspacePath, context?: OperationContext): Promise<string>;
  /** Resolves to true when a new file was created, false when one was replaced. */
  writeFile(path: WorkspacePath, content: string, context?: OperationContext): Promise<boolean>;
}
