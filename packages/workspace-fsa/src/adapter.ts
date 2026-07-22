import type { OperationContext } from '@mgravey/loom-plugin-api';
import {
  workspacePath,
  type ProjectWorkspace,
  type WorkspaceEntry,
  type WorkspacePath,
  type WorkspaceStat,
} from '@mgravey/loom-tool-workspace';

import { FileSystemAccessWorkspaceError } from './errors.js';

export interface FileSystemAccessProjectWorkspace extends ProjectWorkspace {
  readonly root: FileSystemDirectoryHandle;
}

/** Compatibility alias for the original text-only adapter name. */
export type FileSystemAccessTextWorkspace = FileSystemAccessProjectWorkspace;

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

async function readBytes(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<Uint8Array> {
  throwIfCancelled(context);
  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  try {
    const handle = await directory.getFileHandle(name);
    throwIfCancelled(context);
    const file = await handle.getFile();
    throwIfCancelled(context);
    const content = new Uint8Array(await file.arrayBuffer());
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

async function writeContent(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  content: string | Uint8Array,
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
    if (typeof content === 'string') {
      await writable.write(content);
    } else {
      const copied = new Uint8Array(new ArrayBuffer(content.byteLength));
      copied.set(content);
      await writable.write(copied);
    }
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

async function stat(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<WorkspaceStat> {
  throwIfCancelled(context);
  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  try {
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    throwIfCancelled(context);
    return Object.freeze({
      path,
      kind: 'file',
      size: file.size,
      modifiedAt: file.lastModified,
    });
  } catch (error) {
    throwIfCancelled(context);
    if (errorName(error) !== 'TypeMismatchError') {
      if (errorName(error) === 'NotFoundError') throw entryError(error, path, 'file');
      throw new FileSystemAccessWorkspaceError(
        'READ_FAILED',
        `Unable to inspect workspace entry '${path}'.`,
        { path, cause: error },
      );
    }
  }
  try {
    await directory.getDirectoryHandle(name);
    throwIfCancelled(context);
    return Object.freeze({ path, kind: 'directory', size: 0 });
  } catch (error) {
    throwIfCancelled(context);
    throw entryError(error, path, 'directory');
  }
}

async function existingDirectory(
  directory: FileSystemDirectoryHandle,
  name: string,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const handle = await directory.getDirectoryHandle(name);
    throwIfCancelled(context);
    return handle;
  } catch (error) {
    throwIfCancelled(context);
    if (errorName(error) === 'NotFoundError') return undefined;
    if (errorName(error) === 'TypeMismatchError') throw entryError(error, path, 'directory');
    throw new FileSystemAccessWorkspaceError(
      'CREATE_DIRECTORY_FAILED',
      `Unable to access workspace directory '${path}'.`,
      { path, cause: error },
    );
  }
}

async function createDirectory(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  options: Readonly<{ recursive?: boolean }> | undefined,
  context?: OperationContext,
): Promise<boolean> {
  throwIfCancelled(context);
  if (options?.recursive === true) {
    let directory: FileSystemDirectoryHandle = root;
    let traversed = '';
    let created = false;
    for (const segment of path.split('/')) {
      traversed = traversed.length === 0 ? segment : `${traversed}/${segment}`;
      const currentPath = workspacePath(traversed);
      const current = await existingDirectory(directory, segment, currentPath, context);
      if (current === undefined) {
        try {
          directory = await directory.getDirectoryHandle(segment, { create: true });
          created = true;
        } catch (error) {
          throwIfCancelled(context);
          throw new FileSystemAccessWorkspaceError(
            'CREATE_DIRECTORY_FAILED',
            `Unable to create workspace directory '${currentPath}'.`,
            { path: currentPath, cause: error },
          );
        }
      } else {
        directory = current;
      }
    }
    throwIfCancelled(context);
    return created;
  }

  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  const current = await existingDirectory(directory, name, path, context);
  if (current !== undefined) return false;
  try {
    await directory.getDirectoryHandle(name, { create: true });
    throwIfCancelled(context);
    return true;
  } catch (error) {
    throwIfCancelled(context);
    throw new FileSystemAccessWorkspaceError(
      'CREATE_DIRECTORY_FAILED',
      `Unable to create workspace directory '${path}'.`,
      { path, cause: error },
    );
  }
}

interface RemovableDirectoryHandle extends FileSystemDirectoryHandle {
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
}

async function remove(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  options: Readonly<{ recursive?: boolean }> | undefined,
  context?: OperationContext,
): Promise<void> {
  throwIfCancelled(context);
  const { parent, name } = parentAndName(path);
  const directory = await directoryAt(root, parent, context);
  const removable = directory as RemovableDirectoryHandle;
  if (typeof removable.removeEntry !== 'function') {
    throw new FileSystemAccessWorkspaceError(
      'REMOVE_FAILED',
      'This File System Access provider does not support removal.',
      { path },
    );
  }
  try {
    await removable.removeEntry(name, { recursive: options?.recursive === true });
    throwIfCancelled(context);
  } catch (error) {
    throwIfCancelled(context);
    if (errorName(error) === 'NotFoundError') throw entryError(error, path, 'file');
    if (errorName(error) === 'InvalidModificationError') {
      throw new FileSystemAccessWorkspaceError(
        'DIRECTORY_NOT_EMPTY',
        `Workspace directory '${path}' is not empty.`,
        { path, cause: error },
      );
    }
    throw new FileSystemAccessWorkspaceError(
      'REMOVE_FAILED',
      `Unable to remove workspace entry '${path}'.`,
      { path, cause: error },
    );
  }
}

async function entryExists(
  root: IterableDirectoryHandle,
  path: WorkspacePath,
  context?: OperationContext,
): Promise<boolean> {
  try {
    await stat(root, path, context);
    return true;
  } catch (error) {
    if (error instanceof FileSystemAccessWorkspaceError && error.code === 'ENTRY_NOT_FOUND') {
      return false;
    }
    throw error;
  }
}

async function copyEntry(
  root: IterableDirectoryHandle,
  source: WorkspacePath,
  destination: WorkspacePath,
  context?: OperationContext,
): Promise<void> {
  const sourceStat = await stat(root, source, context);
  if (sourceStat.kind === 'file') {
    await writeContent(root, destination, await readBytes(root, source, context), context);
    return;
  }
  await createDirectory(root, destination, { recursive: true }, context);
  for (const entry of await listFiles(root, source, context)) {
    const suffix = entry.path.slice(source.length);
    await copyEntry(root, entry.path, workspacePath(`${destination}${suffix}`), context);
  }
}

async function move(
  root: IterableDirectoryHandle,
  source: WorkspacePath,
  destination: WorkspacePath,
  options: Readonly<{ overwrite?: boolean }> | undefined,
  context?: OperationContext,
): Promise<void> {
  throwIfCancelled(context);
  await stat(root, source, context);
  if (source === destination) return;
  if (destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) {
    throw new FileSystemAccessWorkspaceError(
      'MOVE_FAILED',
      `Workspace entry '${source}' cannot be moved inside itself.`,
      { path: destination },
    );
  }
  if (await entryExists(root, destination, context)) {
    if (options?.overwrite !== true) {
      throw new FileSystemAccessWorkspaceError(
        'ENTRY_EXISTS',
        `Workspace entry '${destination}' already exists.`,
        { path: destination },
      );
    }
    await remove(root, destination, { recursive: true }, context);
  }
  try {
    await copyEntry(root, source, destination, context);
    await remove(root, source, { recursive: true }, context);
  } catch (error) {
    throwIfCancelled(context);
    if (error instanceof FileSystemAccessWorkspaceError) throw error;
    throw new FileSystemAccessWorkspaceError(
      'MOVE_FAILED',
      `Unable to move workspace entry '${source}'.`,
      { path: source, cause: error },
    );
  }
}

export function createFileSystemAccessTextWorkspace(
  root: FileSystemDirectoryHandle,
): FileSystemAccessProjectWorkspace {
  assertRoot(root);
  return Object.freeze({
    root,
    listFiles: (path: WorkspacePath | undefined, context?: OperationContext) =>
      listFiles(root, path, context),
    readFile: (path: WorkspacePath, context?: OperationContext) => readFile(root, path, context),
    writeFile: (path: WorkspacePath, content: string, context?: OperationContext) =>
      writeContent(root, path, content, context),
    stat: (path: WorkspacePath, context?: OperationContext) => stat(root, path, context),
    readBytes: (path: WorkspacePath, context?: OperationContext) => readBytes(root, path, context),
    writeBytes: (path: WorkspacePath, content: Uint8Array, context?: OperationContext) =>
      writeContent(root, path, content, context),
    createDirectory: (
      path: WorkspacePath,
      options?: Readonly<{ recursive?: boolean }>,
      context?: OperationContext,
    ) => createDirectory(root, path, options, context),
    move: (
      source: WorkspacePath,
      destination: WorkspacePath,
      options?: Readonly<{ overwrite?: boolean }>,
      context?: OperationContext,
    ) => move(root, source, destination, options, context),
    remove: (
      path: WorkspacePath,
      options?: Readonly<{ recursive?: boolean }>,
      context?: OperationContext,
    ) => remove(root, path, options, context),
  });
}

export const createFileSystemAccessProjectWorkspace = createFileSystemAccessTextWorkspace;
