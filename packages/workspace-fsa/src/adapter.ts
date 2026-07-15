import type { OperationContext } from '@loom/plugin-api';
import {
  workspacePath,
  type TextWorkspace,
  type WorkspaceEntry,
  type WorkspacePath,
} from '@loom/tool-workspace';

import { FileSystemAccessWorkspaceError } from './errors.js';

export interface FileSystemAccessTextWorkspace extends TextWorkspace {
  readonly root: FileSystemDirectoryHandle;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<readonly [string, FileSystemHandle]>;
}

function assertRoot(root: unknown): asserts root is IterableDirectoryHandle {
  const candidate = root as {
    readonly kind?: unknown;
    readonly getDirectoryHandle?: unknown;
    readonly getFileHandle?: unknown;
    readonly entries?: unknown;
  };
  if (
    typeof root !== 'object' ||
    root === null ||
    candidate.kind !== 'directory' ||
    typeof candidate.getDirectoryHandle !== 'function' ||
    typeof candidate.getFileHandle !== 'function' ||
    typeof candidate.entries !== 'function'
  ) {
    throw new FileSystemAccessWorkspaceError(
      'INVALID_ROOT',
      'A File System Access directory handle is required.',
    );
  }
}

function iterableDirectory(
  handle: FileSystemDirectoryHandle,
  path: WorkspacePath,
): IterableDirectoryHandle {
  if (typeof (handle as { readonly entries?: unknown }).entries !== 'function') {
    throw new FileSystemAccessWorkspaceError(
      'LIST_FAILED',
      `Workspace directory '${path}' cannot be enumerated.`,
      { path },
    );
  }
  return handle as IterableDirectoryHandle;
}

function throwIfCancelled(context?: OperationContext): void {
  context?.signal?.throwIfCancelled();
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('name' in error)) return undefined;
  return typeof error.name === 'string' ? error.name : undefined;
}

function entryError(
  error: unknown,
  path: WorkspacePath,
  expected: 'directory' | 'file',
): FileSystemAccessWorkspaceError {
  const name = errorName(error);
  if (name === 'NotFoundError') {
    return new FileSystemAccessWorkspaceError(
      'ENTRY_NOT_FOUND',
      `Workspace entry '${path}' does not exist.`,
      { path, cause: error },
    );
  }
  if (name === 'TypeMismatchError') {
    const code = expected === 'directory' ? 'EXPECTED_DIRECTORY' : 'EXPECTED_FILE';
    return new FileSystemAccessWorkspaceError(
      code,
      `Workspace entry '${path}' is not a ${expected}.`,
      { path, cause: error },
    );
  }
  const code = expected === 'directory' ? 'LIST_FAILED' : 'READ_FAILED';
  return new FileSystemAccessWorkspaceError(
    code,
    `Unable to access workspace ${expected} '${path}'.`,
    { path, cause: error },
  );
}

async function directoryAt(
  root: IterableDirectoryHandle,
  path: WorkspacePath | undefined,
  context?: OperationContext,
): Promise<IterableDirectoryHandle> {
  throwIfCancelled(context);
  let directory = root;
  if (path === undefined) return directory;
  let traversed = '';
  for (const segment of path.split('/')) {
    throwIfCancelled(context);
    traversed = traversed.length === 0 ? segment : `${traversed}/${segment}`;
    const currentPath = workspacePath(traversed);
    try {
      directory = iterableDirectory(await directory.getDirectoryHandle(segment), currentPath);
    } catch (error) {
      throwIfCancelled(context);
      throw entryError(error, currentPath, 'directory');
    }
  }
  throwIfCancelled(context);
  return directory;
}

function parentAndName(path: WorkspacePath): {
  readonly parent: WorkspacePath | undefined;
  readonly name: string;
} {
  const separator = path.lastIndexOf('/');
  if (separator < 0) return Object.freeze({ parent: undefined, name: path });
  return Object.freeze({
    parent: workspacePath(path.slice(0, separator)),
    name: path.slice(separator + 1),
  });
}

function childPath(parent: WorkspacePath | undefined, name: string): WorkspacePath {
  return workspacePath(parent === undefined ? name : `${parent}/${name}`);
}

async function listFiles(
  root: IterableDirectoryHandle,
  path: WorkspacePath | undefined,
  context?: OperationContext,
): Promise<readonly WorkspaceEntry[]> {
  throwIfCancelled(context);
  const directory = await directoryAt(root, path, context);
  const entries: WorkspaceEntry[] = [];
  try {
    for await (const [name, handle] of directory.entries()) {
      throwIfCancelled(context);
      entries.push(Object.freeze({ path: childPath(path, name), kind: handle.kind }));
    }
  } catch (error) {
    throwIfCancelled(context);
    throw new FileSystemAccessWorkspaceError(
      'LIST_FAILED',
      `Unable to list workspace directory '${path ?? '.'}'.`,
      { ...(path === undefined ? {} : { path }), cause: error },
    );
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  throwIfCancelled(context);
  return Object.freeze(entries);
}

async function readFile(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<string> {
  throwIfCancelled(context);
  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  try {
    throwIfCancelled(context);
    const handle = await directory.getFileHandle(name);
    throwIfCancelled(context);
    const file = await handle.getFile();
    throwIfCancelled(context);
    const content = await file.text();
    throwIfCancelled(context);
    return content;
  } catch (error) {
    throwIfCancelled(context);
    if (errorName(error) === 'NotFoundError' || errorName(error) === 'TypeMismatchError') {
      throw entryError(error, path, 'file');
    }
    throw new FileSystemAccessWorkspaceError(
      'READ_FAILED',
      `Unable to read workspace file '${path}'.`,
      { path, cause: error },
    );
  }
}

async function existingFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<FileSystemFileHandle | undefined> {
  try {
    const handle = await directory.getFileHandle(name);
    throwIfCancelled(context);
    return handle;
  } catch (error) {
    throwIfCancelled(context);
    if (errorName(error) === 'NotFoundError') return undefined;
    if (errorName(error) === 'TypeMismatchError') throw entryError(error, path, 'file');
    throw new FileSystemAccessWorkspaceError(
      'WRITE_FAILED',
      `Unable to access workspace file '${path}' for writing.`,
      { path, cause: error },
    );
  }
}

async function writeFile(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  content: string,
  context?: OperationContext,
): Promise<boolean> {
  throwIfCancelled(context);
  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  const current = await existingFile(directory, name, path, context);
  const created = current === undefined;
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const handle = current ?? (await directory.getFileHandle(name, { create: true }));
    throwIfCancelled(context);
    writable = await handle.createWritable();
    throwIfCancelled(context);
    await writable.write(content);
    throwIfCancelled(context);
    await writable.close();
    writable = undefined;
    throwIfCancelled(context);
    return created;
  } catch (error) {
    if (writable !== undefined) {
      try {
        await writable.abort(error);
      } catch {
        // Best-effort rollback; the original failure remains authoritative.
      }
    }
    throwIfCancelled(context);
    if (errorName(error) === 'TypeMismatchError') throw entryError(error, path, 'file');
    throw new FileSystemAccessWorkspaceError(
      'WRITE_FAILED',
      `Unable to write workspace file '${path}'.`,
      { path, cause: error },
    );
  }
}

export function createFileSystemAccessTextWorkspace(
  root: FileSystemDirectoryHandle,
): FileSystemAccessTextWorkspace {
  assertRoot(root);
  return Object.freeze({
    root,
    listFiles: (path: WorkspacePath | undefined, context?: OperationContext) =>
      listFiles(root, path, context),
    readFile: (path: WorkspacePath, context?: OperationContext) => readFile(root, path, context),
    writeFile: (path: WorkspacePath, content: string, context?: OperationContext) =>
      writeFile(root, path, content, context),
  });
}
