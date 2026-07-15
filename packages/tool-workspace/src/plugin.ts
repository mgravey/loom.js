import {
  CAPABILITY_KINDS,
  PLUGIN_API_VERSION,
  createCapabilityKey,
  definePlugin,
  type LoomPlugin,
  type OperationContext,
} from '@loom/plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@loom/types';

import {
  WORKSPACE_OPERATIONS,
  type ListFilesInput,
  type ListFilesOutput,
  type ListFilesTool,
  type ReadFileInput,
  type ReadFileOutput,
  type ReadFileTool,
  type TextWorkspace,
  type WorkspaceEntry,
  type WriteFileInput,
  type WriteFileOutput,
  type WriteFileTool,
} from './contracts.js';
import { isWorkspacePath, workspacePath, type WorkspacePath } from './path.js';

export const WORKSPACE_TOOLS_PLUGIN_ID = pluginId('loom/workspace-tools');

export const WORKSPACE_TOOL_CAPABILITY_IDS = Object.freeze({
  listFiles: capabilityId('loom/workspace-list-files'),
  readFile: capabilityId('loom/workspace-read-file'),
  writeFile: capabilityId('loom/workspace-write-file'),
});

export const LIST_FILES_TOOL_KEY = createCapabilityKey<ListFilesTool>(
  CAPABILITY_KINDS.tool,
  WORKSPACE_TOOL_CAPABILITY_IDS.listFiles,
);
export const READ_FILE_TOOL_KEY = createCapabilityKey<ReadFileTool>(
  CAPABILITY_KINDS.tool,
  WORKSPACE_TOOL_CAPABILITY_IDS.readFile,
);
export const WRITE_FILE_TOOL_KEY = createCapabilityKey<WriteFileTool>(
  CAPABILITY_KINDS.tool,
  WORKSPACE_TOOL_CAPABILITY_IDS.writeFile,
);

export interface CreateWorkspaceToolsPluginOptions {
  readonly workspace: TextWorkspace;
}

function throwIfCancelled(context?: OperationContext): void {
  context?.signal?.throwIfCancelled();
}

function inputRecord(value: unknown, operation: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${operation} input must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${operation} input must be a plain object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${operation} input contains unknown property "${key}".`);
    }
  }
}

function requiredPath(record: Readonly<Record<string, unknown>>, operation: string): WorkspacePath {
  if (typeof record.path !== 'string') {
    throw new TypeError(`${operation} input requires a string path.`);
  }
  return workspacePath(record.path);
}

function listInput(value: unknown): Readonly<ListFilesInput> {
  const record = inputRecord(value, 'list_files');
  exactKeys(record, ['path'], 'list_files');
  if (!Object.prototype.hasOwnProperty.call(record, 'path')) return Object.freeze({});
  if (typeof record.path !== 'string') {
    throw new TypeError('list_files path must be a string when provided.');
  }
  return Object.freeze({ path: workspacePath(record.path) });
}

function readInput(value: unknown): Readonly<ReadFileInput> {
  const record = inputRecord(value, 'read_file');
  exactKeys(record, ['path'], 'read_file');
  return Object.freeze({ path: requiredPath(record, 'read_file') });
}

function writeInput(value: unknown): Readonly<WriteFileInput> {
  const record = inputRecord(value, 'write_file');
  exactKeys(record, ['path', 'content'], 'write_file');
  if (typeof record.content !== 'string') {
    throw new TypeError('write_file input requires string content.');
  }
  return Object.freeze({
    path: requiredPath(record, 'write_file'),
    content: record.content,
  });
}

function isImmediateChild(parent: WorkspacePath | undefined, child: WorkspacePath): boolean {
  if (parent === undefined) return !child.includes('/');
  const prefix = `${parent}/`;
  return child.startsWith(prefix) && !child.slice(prefix.length).includes('/');
}

function immutableEntry(value: unknown, parent: WorkspacePath | undefined): WorkspaceEntry {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Workspace returned an invalid entry.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.path !== 'string' || !isWorkspacePath(record.path)) {
    throw new TypeError('Workspace returned an entry with an invalid path.');
  }
  if (record.kind !== 'file' && record.kind !== 'directory') {
    throw new TypeError('Workspace returned an entry with an invalid kind.');
  }
  if (!isImmediateChild(parent, record.path)) {
    throw new TypeError(`Workspace entry "${record.path}" is not an immediate child.`);
  }
  return Object.freeze({ path: record.path, kind: record.kind });
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function createTools(
  workspace: TextWorkspace,
): readonly [ListFilesTool, ReadFileTool, WriteFileTool] {
  const listFiles: ListFilesTool = Object.freeze({
    name: 'list_files',
    description: 'List the immediate files and directories in a workspace directory.',
    operation: WORKSPACE_OPERATIONS.listFiles,
    async execute(input: ListFilesInput, context?: OperationContext): Promise<ListFilesOutput> {
      const validated = listInput(input);
      throwIfCancelled(context);
      const values: unknown = await workspace.listFiles(validated.path, context);
      throwIfCancelled(context);
      if (!Array.isArray(values)) {
        throw new TypeError('Workspace listFiles must return an array.');
      }
      const entries = (values as readonly unknown[]).map((entry) =>
        immutableEntry(entry, validated.path),
      );
      entries.sort(compareEntries);
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (previous !== undefined && current?.path === previous.path) {
          throw new TypeError(`Workspace returned duplicate entry "${current.path}".`);
        }
      }
      return Object.freeze({ entries: Object.freeze(entries) });
    },
  });

  const readFile: ReadFileTool = Object.freeze({
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    operation: WORKSPACE_OPERATIONS.readFile,
    async execute(input: ReadFileInput, context?: OperationContext): Promise<ReadFileOutput> {
      const validated = readInput(input);
      throwIfCancelled(context);
      const content: unknown = await workspace.readFile(validated.path, context);
      throwIfCancelled(context);
      if (typeof content !== 'string') {
        throw new TypeError('Workspace readFile must return a string.');
      }
      return Object.freeze({ path: validated.path, content });
    },
  });

  const writeFile: WriteFileTool = Object.freeze({
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file in the workspace.',
    operation: WORKSPACE_OPERATIONS.writeFile,
    async execute(input: WriteFileInput, context?: OperationContext): Promise<WriteFileOutput> {
      const validated = writeInput(input);
      throwIfCancelled(context);
      const created: unknown = await workspace.writeFile(
        validated.path,
        validated.content,
        context,
      );
      throwIfCancelled(context);
      if (typeof created !== 'boolean') {
        throw new TypeError('Workspace writeFile must return a boolean.');
      }
      return Object.freeze({ path: validated.path, created });
    },
  });

  return Object.freeze([listFiles, readFile, writeFile]);
}

function assertWorkspace(workspace: unknown): asserts workspace is TextWorkspace {
  if (
    typeof workspace !== 'object' ||
    workspace === null ||
    !('listFiles' in workspace) ||
    typeof workspace.listFiles !== 'function' ||
    !('readFile' in workspace) ||
    typeof workspace.readFile !== 'function' ||
    !('writeFile' in workspace) ||
    typeof workspace.writeFile !== 'function'
  ) {
    throw new TypeError('A TextWorkspace implementation is required.');
  }
}

export function createWorkspaceToolsPlugin(options: CreateWorkspaceToolsPluginOptions): LoomPlugin {
  assertWorkspace(options.workspace);
  const [listFiles, readFile, writeFile] = createTools(options.workspace);

  return definePlugin({
    manifest: {
      id: WORKSPACE_TOOLS_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      context.capabilities.register(LIST_FILES_TOOL_KEY, listFiles);
      context.capabilities.register(READ_FILE_TOOL_KEY, readFile);
      context.capabilities.register(WRITE_FILE_TOOL_KEY, writeFile);
    },
  });
}
