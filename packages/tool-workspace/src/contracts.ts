import type { OperationContext, Tool } from '@mgravey/loom-plugin-api';

import type { WorkspacePath } from './path.js';

export const WORKSPACE_OPERATIONS = Object.freeze({
  listFiles: 'workspace/list-files',
  readFile: 'workspace/read-file',
  writeFile: 'workspace/write-file',
  stat: 'workspace/stat',
  readBytes: 'workspace/read-bytes',
  writeBytes: 'workspace/write-bytes',
  createDirectory: 'workspace/create-directory',
  move: 'workspace/move',
  remove: 'workspace/remove',
  applyPatch: 'workspace/apply-patch',
} as const);

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[keyof typeof WORKSPACE_OPERATIONS];
export type WorkspaceEntryKind = 'file' | 'directory';

export interface WorkspaceEntry {
  readonly path: WorkspacePath;
  readonly kind: WorkspaceEntryKind;
}

export interface WorkspaceStat extends WorkspaceEntry {
  /** Byte size for files. Directories report zero. */
  readonly size: number;
  /** Milliseconds since the Unix epoch when the provider exposes it. */
  readonly modifiedAt?: number;
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

export interface StatInput {
  readonly path: WorkspacePath;
}

export interface StatOutput {
  readonly entry: WorkspaceStat;
}

export interface ReadBytesInput {
  readonly path: WorkspacePath;
}

export interface ReadBytesOutput {
  readonly path: WorkspacePath;
  readonly content: Uint8Array;
}

export interface WriteBytesInput {
  readonly path: WorkspacePath;
  readonly content: Uint8Array;
}

export type WriteBytesOutput = WriteFileOutput;

export interface CreateDirectoryInput {
  readonly path: WorkspacePath;
  readonly recursive?: boolean;
}

export interface CreateDirectoryOutput {
  readonly path: WorkspacePath;
  readonly created: boolean;
}

export interface MoveInput {
  readonly source: WorkspacePath;
  readonly destination: WorkspacePath;
  readonly overwrite?: boolean;
}

export interface MoveOutput {
  readonly source: WorkspacePath;
  readonly destination: WorkspacePath;
}

export interface RemoveInput {
  readonly path: WorkspacePath;
  readonly recursive?: boolean;
}

export interface RemoveOutput {
  readonly path: WorkspacePath;
}

export interface ApplyPatchInput {
  readonly path: WorkspacePath;
  /** A unified diff containing one file and one or more exact-context hunks. */
  readonly patch: string;
}

export interface ApplyPatchOutput {
  readonly path: WorkspacePath;
  readonly created: boolean;
  readonly hunksApplied: number;
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

export interface StatTool extends Tool<StatInput, StatOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.stat;
}

export interface ReadBytesTool extends Tool<ReadBytesInput, ReadBytesOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.readBytes;
}

export interface WriteBytesTool extends Tool<WriteBytesInput, WriteBytesOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.writeBytes;
}

export interface CreateDirectoryTool extends Tool<CreateDirectoryInput, CreateDirectoryOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.createDirectory;
}

export interface MoveTool extends Tool<MoveInput, MoveOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.move;
}

export interface RemoveTool extends Tool<RemoveInput, RemoveOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.remove;
}

export interface ApplyPatchTool extends Tool<ApplyPatchInput, ApplyPatchOutput> {
  readonly operation: typeof WORKSPACE_OPERATIONS.applyPatch;
}

export type WorkspaceTool =
  | ListFilesTool
  | ReadFileTool
  | WriteFileTool
  | StatTool
  | ReadBytesTool
  | WriteBytesTool
  | CreateDirectoryTool
  | MoveTool
  | RemoveTool
  | ApplyPatchTool;

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

/**
 * A binary-capable mutable project workspace. Text methods remain available for
 * compatibility and use UTF-8 encoding.
 */
export interface ProjectWorkspace extends TextWorkspace {
  stat(path: WorkspacePath, context?: OperationContext): Promise<WorkspaceStat>;
  readBytes(path: WorkspacePath, context?: OperationContext): Promise<Uint8Array>;
  writeBytes(
    path: WorkspacePath,
    content: Uint8Array,
    context?: OperationContext,
  ): Promise<boolean>;
  /** Resolves to true when a directory was created. */
  createDirectory(
    path: WorkspacePath,
    options?: Readonly<{ recursive?: boolean }>,
    context?: OperationContext,
  ): Promise<boolean>;
  move(
    source: WorkspacePath,
    destination: WorkspacePath,
    options?: Readonly<{ overwrite?: boolean }>,
    context?: OperationContext,
  ): Promise<void>;
  remove(
    path: WorkspacePath,
    options?: Readonly<{ recursive?: boolean }>,
    context?: OperationContext,
  ): Promise<void>;
}

export function isProjectWorkspace(workspace: TextWorkspace): workspace is ProjectWorkspace {
  const candidate = workspace as Partial<ProjectWorkspace>;
  return (
    typeof candidate.stat === 'function' &&
    typeof candidate.readBytes === 'function' &&
    typeof candidate.writeBytes === 'function' &&
    typeof candidate.createDirectory === 'function' &&
    typeof candidate.move === 'function' &&
    typeof candidate.remove === 'function'
  );
}
