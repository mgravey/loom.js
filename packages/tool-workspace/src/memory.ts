import type { OperationContext } from '@mgravey/loom-plugin-api';

import type {
  ProjectWorkspace,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceStat,
} from './contracts.js';
import { workspacePath, type WorkspacePath } from './path.js';

export type MemoryWorkspaceErrorCode =
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_EXISTS'
  | 'EXPECTED_FILE'
  | 'EXPECTED_DIRECTORY'
  | 'DIRECTORY_NOT_EMPTY'
  | 'INVALID_MOVE';

export class MemoryWorkspaceError extends Error {
  readonly code: MemoryWorkspaceErrorCode;
  readonly path: WorkspacePath;

  constructor(code: MemoryWorkspaceErrorCode, message: string, path: WorkspacePath) {
    super(message);
    this.name = 'MemoryWorkspaceError';
    this.code = code;
    this.path = path;
  }
}

export type MemoryWorkspaceInitialEntry =
  | Readonly<{ path: WorkspacePath; kind: 'directory'; modifiedAt?: number }>
  | Readonly<{
      path: WorkspacePath;
      kind: 'file';
      content: string | Uint8Array;
      modifiedAt?: number;
    }>;

export interface CreateMemoryProjectWorkspaceOptions {
  readonly entries?: readonly MemoryWorkspaceInitialEntry[];
  readonly now?: () => number;
}

interface DirectoryNode {
  readonly kind: 'directory';
  modifiedAt: number;
}

interface FileNode {
  readonly kind: 'file';
  content: Uint8Array;
  modifiedAt: number;
}

type Node = DirectoryNode | FileNode;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function throwIfCancelled(context?: OperationContext): void {
  context?.signal?.throwIfCancelled();
}

function parentPath(path: WorkspacePath): WorkspacePath | undefined {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? undefined : workspacePath(path.slice(0, separator));
}

function descendants(
  nodes: ReadonlyMap<WorkspacePath, Node>,
  path: WorkspacePath,
): WorkspacePath[] {
  const prefix = `${path}/`;
  return [...nodes.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
}

function immutableEntry(path: WorkspacePath, kind: WorkspaceEntryKind): WorkspaceEntry {
  return Object.freeze({ path, kind });
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function requireNode(nodes: ReadonlyMap<WorkspacePath, Node>, path: WorkspacePath): Node {
  const node = nodes.get(path);
  if (node === undefined) {
    throw new MemoryWorkspaceError(
      'ENTRY_NOT_FOUND',
      `Workspace entry '${path}' does not exist.`,
      path,
    );
  }
  return node;
}

function requireDirectory(
  nodes: ReadonlyMap<WorkspacePath, Node>,
  path: WorkspacePath,
): DirectoryNode {
  const node = requireNode(nodes, path);
  if (node.kind !== 'directory') {
    throw new MemoryWorkspaceError(
      'EXPECTED_DIRECTORY',
      `Workspace entry '${path}' is not a directory.`,
      path,
    );
  }
  return node;
}

function requireFile(nodes: ReadonlyMap<WorkspacePath, Node>, path: WorkspacePath): FileNode {
  const node = requireNode(nodes, path);
  if (node.kind !== 'file') {
    throw new MemoryWorkspaceError(
      'EXPECTED_FILE',
      `Workspace entry '${path}' is not a file.`,
      path,
    );
  }
  return node;
}

function assertParentDirectory(nodes: ReadonlyMap<WorkspacePath, Node>, path: WorkspacePath): void {
  const parent = parentPath(path);
  if (parent !== undefined) requireDirectory(nodes, parent);
}

function addInitialEntries(
  nodes: Map<WorkspacePath, Node>,
  entries: readonly MemoryWorkspaceInitialEntry[],
  now: () => number,
): void {
  const sorted = [...entries].sort((left, right) => {
    const depth = left.path.split('/').length - right.path.split('/').length;
    return depth === 0 ? left.path.localeCompare(right.path) : depth;
  });
  for (const entry of sorted) {
    if (nodes.has(entry.path)) {
      throw new MemoryWorkspaceError(
        'ENTRY_EXISTS',
        `Duplicate initial workspace entry '${entry.path}'.`,
        entry.path,
      );
    }
    assertParentDirectory(nodes, entry.path);
    const modifiedAt = entry.modifiedAt ?? now();
    nodes.set(
      entry.path,
      entry.kind === 'directory'
        ? { kind: 'directory', modifiedAt }
        : {
            kind: 'file',
            content:
              typeof entry.content === 'string'
                ? encoder.encode(entry.content)
                : cloneBytes(entry.content),
            modifiedAt,
          },
    );
  }
}

export function createMemoryProjectWorkspace(
  options: CreateMemoryProjectWorkspaceOptions = {},
): ProjectWorkspace {
  const nodes = new Map<WorkspacePath, Node>();
  const now = options.now ?? Date.now;
  addInitialEntries(nodes, options.entries ?? [], now);

  const workspace: ProjectWorkspace = {
    async listFiles(path, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      if (path !== undefined) requireDirectory(nodes, path);
      const prefix = path === undefined ? '' : `${path}/`;
      const entries = [...nodes.entries()]
        .filter(([candidate]) => {
          if (!candidate.startsWith(prefix)) return false;
          return !candidate.slice(prefix.length).includes('/');
        })
        .map(([candidate, node]) => immutableEntry(candidate, node.kind))
        .sort((left, right) => left.path.localeCompare(right.path));
      throwIfCancelled(context);
      return Object.freeze(entries);
    },

    async stat(path, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      const node = requireNode(nodes, path);
      const stat: WorkspaceStat = Object.freeze({
        path,
        kind: node.kind,
        size: node.kind === 'file' ? node.content.byteLength : 0,
        modifiedAt: node.modifiedAt,
      });
      throwIfCancelled(context);
      return stat;
    },

    async readBytes(path, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      const content = cloneBytes(requireFile(nodes, path).content);
      throwIfCancelled(context);
      return content;
    },

    async readFile(path, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      let value: string;
      try {
        value = decoder.decode(requireFile(nodes, path).content);
      } catch (cause) {
        throw new TypeError(`Workspace file '${path}' is not valid UTF-8.`, { cause });
      }
      throwIfCancelled(context);
      return value;
    },

    async writeBytes(path, content, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      assertParentDirectory(nodes, path);
      const current = nodes.get(path);
      if (current?.kind === 'directory') {
        throw new MemoryWorkspaceError(
          'EXPECTED_FILE',
          `Workspace entry '${path}' is not a file.`,
          path,
        );
      }
      const created = current === undefined;
      nodes.set(path, { kind: 'file', content: cloneBytes(content), modifiedAt: now() });
      throwIfCancelled(context);
      return created;
    },

    async writeFile(path, content, context) {
      return workspace.writeBytes(path, encoder.encode(content), context);
    },

    async createDirectory(path, directoryOptions, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      const current = nodes.get(path);
      if (current !== undefined) {
        if (current.kind !== 'directory') {
          throw new MemoryWorkspaceError(
            'EXPECTED_DIRECTORY',
            `Workspace entry '${path}' is not a directory.`,
            path,
          );
        }
        return false;
      }

      const missing: WorkspacePath[] = [];
      let candidate: WorkspacePath | undefined = path;
      while (candidate !== undefined && !nodes.has(candidate)) {
        missing.push(candidate);
        candidate = parentPath(candidate);
      }
      if (candidate !== undefined) requireDirectory(nodes, candidate);
      if (missing.length > 1 && directoryOptions?.recursive !== true) {
        const missingParent = missing[missing.length - 1] ?? path;
        throw new MemoryWorkspaceError(
          'ENTRY_NOT_FOUND',
          `Parent directory '${missingParent}' does not exist.`,
          missingParent,
        );
      }
      for (const directory of missing.reverse()) {
        nodes.set(directory, { kind: 'directory', modifiedAt: now() });
      }
      throwIfCancelled(context);
      return true;
    },

    async move(source, destination, moveOptions, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      requireNode(nodes, source);
      if (source === destination) return;
      if (destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) {
        throw new MemoryWorkspaceError(
          'INVALID_MOVE',
          `Workspace entry '${source}' cannot be moved inside itself.`,
          destination,
        );
      }
      assertParentDirectory(nodes, destination);
      const destinationNode = nodes.get(destination);
      if (destinationNode !== undefined && moveOptions?.overwrite !== true) {
        throw new MemoryWorkspaceError(
          'ENTRY_EXISTS',
          `Workspace entry '${destination}' already exists.`,
          destination,
        );
      }
      if (destinationNode !== undefined) {
        for (const child of descendants(nodes, destination)) nodes.delete(child);
        nodes.delete(destination);
      }

      const moving = [source, ...descendants(nodes, source)];
      const replacements = moving.map((oldPath) => {
        const suffix = oldPath.slice(source.length);
        return [workspacePath(`${destination}${suffix}`), requireNode(nodes, oldPath)] as const;
      });
      for (const oldPath of moving) nodes.delete(oldPath);
      for (const [newPath, node] of replacements) nodes.set(newPath, node);
      throwIfCancelled(context);
    },

    async remove(path, removeOptions, context) {
      await Promise.resolve();
      throwIfCancelled(context);
      const node = requireNode(nodes, path);
      const children = descendants(nodes, path);
      if (node.kind === 'directory' && children.length > 0 && removeOptions?.recursive !== true) {
        throw new MemoryWorkspaceError(
          'DIRECTORY_NOT_EMPTY',
          `Workspace directory '${path}' is not empty.`,
          path,
        );
      }
      for (const child of children) nodes.delete(child);
      nodes.delete(path);
      throwIfCancelled(context);
    },
  };

  return Object.freeze(workspace);
}
