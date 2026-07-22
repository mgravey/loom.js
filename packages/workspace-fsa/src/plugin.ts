import {
  CAPABILITY_KINDS,
  PLUGIN_API_VERSION,
  createCapabilityKey,
  definePlugin,
  type LoomPlugin,
  type OperationContext,
} from '@mgravey/loom-plugin-api';
import {
  WORKSPACE_OPERATIONS,
  workspacePath,
  type ListFilesInput,
  type ListFilesTool,
  type ReadFileInput,
  type ReadFileTool,
  type WriteFileInput,
  type WriteFileTool,
} from '@mgravey/loom-tool-workspace';
import { capabilityId, pluginId, semanticVersion } from '@mgravey/loom-types';

import { createFileSystemAccessTextWorkspace } from './adapter.js';

export const FSA_WORKSPACE_PLUGIN_ID = pluginId('loom/workspace-fsa');
export const FSA_WORKSPACE_TOOL_CAPABILITY_IDS = Object.freeze({
  listFiles: capabilityId('loom-fsa/list-files'),
  readFile: capabilityId('loom-fsa/read-file'),
  writeFile: capabilityId('loom-fsa/write-file'),
});

export const FSA_LIST_FILES_TOOL_KEY = createCapabilityKey<ListFilesTool>(
  CAPABILITY_KINDS.tool,
  FSA_WORKSPACE_TOOL_CAPABILITY_IDS.listFiles,
);
export const FSA_READ_FILE_TOOL_KEY = createCapabilityKey<ReadFileTool>(
  CAPABILITY_KINDS.tool,
  FSA_WORKSPACE_TOOL_CAPABILITY_IDS.readFile,
);
export const FSA_WRITE_FILE_TOOL_KEY = createCapabilityKey<WriteFileTool>(
  CAPABILITY_KINDS.tool,
  FSA_WORKSPACE_TOOL_CAPABILITY_IDS.writeFile,
);

function recordInput(value: unknown, operation: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${operation} input must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function pathInput(value: unknown, operation: string): string {
  const record = recordInput(value, operation);
  if (typeof record.path !== 'string') throw new TypeError(`${operation} requires a path.`);
  return record.path;
}

export function createFileSystemAccessWorkspacePlugin(root: FileSystemDirectoryHandle): LoomPlugin {
  const workspace = createFileSystemAccessTextWorkspace(root);
  const listFiles: ListFilesTool = Object.freeze({
    name: 'list_files',
    description: 'List immediate entries through the File System Access API.',
    operation: WORKSPACE_OPERATIONS.listFiles,
    async execute(input: ListFilesInput, context?: OperationContext) {
      const record = recordInput(input, 'list_files');
      if (Object.keys(record).some((key) => key !== 'path')) {
        throw new TypeError('list_files contains an unsupported property.');
      }
      const path =
        record.path === undefined
          ? undefined
          : typeof record.path === 'string'
            ? workspacePath(record.path)
            : (() => {
                throw new TypeError('list_files path must be a string.');
              })();
      return Object.freeze({ entries: await workspace.listFiles(path, context) });
    },
  });
  const readFile: ReadFileTool = Object.freeze({
    name: 'read_file',
    description: 'Read UTF-8 text through the File System Access API.',
    operation: WORKSPACE_OPERATIONS.readFile,
    async execute(input: ReadFileInput, context?: OperationContext) {
      const record = recordInput(input, 'read_file');
      if (Object.keys(record).some((key) => key !== 'path')) {
        throw new TypeError('read_file contains an unsupported property.');
      }
      const path = workspacePath(pathInput(record, 'read_file'));
      return Object.freeze({ path, content: await workspace.readFile(path, context) });
    },
  });
  const writeFile: WriteFileTool = Object.freeze({
    name: 'write_file',
    description: 'Create or replace UTF-8 text through the File System Access API.',
    operation: WORKSPACE_OPERATIONS.writeFile,
    async execute(input: WriteFileInput, context?: OperationContext) {
      const record = recordInput(input, 'write_file');
      if (Object.keys(record).some((key) => key !== 'path' && key !== 'content')) {
        throw new TypeError('write_file contains an unsupported property.');
      }
      const path = workspacePath(pathInput(record, 'write_file'));
      if (typeof record.content !== 'string') throw new TypeError('write_file requires content.');
      return Object.freeze({
        path,
        created: await workspace.writeFile(path, record.content, context),
      });
    },
  });

  return definePlugin({
    manifest: {
      id: FSA_WORKSPACE_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      context.capabilities.register(FSA_LIST_FILES_TOOL_KEY, listFiles);
      context.capabilities.register(FSA_READ_FILE_TOOL_KEY, readFile);
      context.capabilities.register(FSA_WRITE_FILE_TOOL_KEY, writeFile);
    },
  });
}
