import {
  CAPABILITY_KINDS,
  PLUGIN_API_VERSION,
  createCapabilityKey,
  definePlugin,
  type LoomPlugin,
  type OperationContext,
} from '@mgravey/loom-plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@mgravey/loom-types';

import {
  WORKSPACE_OPERATIONS,
  type ApplyPatchTool,
  type CreateDirectoryInput,
  type CreateDirectoryTool,
  type MoveInput,
  type MoveTool,
  type ProjectWorkspace,
  type ReadBytesInput,
  type ReadBytesTool,
  type RemoveInput,
  type RemoveTool,
  type StatInput,
  type StatTool,
  type WriteBytesInput,
  type WriteBytesTool,
} from './contracts.js';
import { createStrictApplyPatchTool } from './patch.js';
import { workspacePath, type WorkspacePath } from './path.js';
import {
  LIST_FILES_TOOL_KEY,
  READ_FILE_TOOL_KEY,
  WRITE_FILE_TOOL_KEY,
  createWorkspaceTools,
} from './plugin.js';

export const PROJECT_WORKSPACE_TOOLS_PLUGIN_ID = pluginId('loom/project-workspace-tools');
export const PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS = Object.freeze({
  stat: capabilityId('loom/workspace-stat'),
  readBytes: capabilityId('loom/workspace-read-bytes'),
  writeBytes: capabilityId('loom/workspace-write-bytes'),
  createDirectory: capabilityId('loom/workspace-create-directory'),
  move: capabilityId('loom/workspace-move'),
  remove: capabilityId('loom/workspace-remove'),
  applyPatch: capabilityId('loom/workspace-apply-patch'),
});

export const STAT_TOOL_KEY = createCapabilityKey<StatTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.stat,
);
export const READ_BYTES_TOOL_KEY = createCapabilityKey<ReadBytesTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.readBytes,
);
export const WRITE_BYTES_TOOL_KEY = createCapabilityKey<WriteBytesTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.writeBytes,
);
export const CREATE_DIRECTORY_TOOL_KEY = createCapabilityKey<CreateDirectoryTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.createDirectory,
);
export const MOVE_TOOL_KEY = createCapabilityKey<MoveTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.move,
);
export const REMOVE_TOOL_KEY = createCapabilityKey<RemoveTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.remove,
);
export const APPLY_PATCH_TOOL_KEY = createCapabilityKey<ApplyPatchTool>(
  CAPABILITY_KINDS.tool,
  PROJECT_WORKSPACE_TOOL_CAPABILITY_IDS.applyPatch,
);

function record(value: unknown, operation: string): Readonly<Record<string, unknown>> {
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
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new TypeError(`${operation} contains unknown property '${key}'.`);
  }
}

function pathValue(value: unknown, operation: string): WorkspacePath {
  if (typeof value !== 'string') throw new TypeError(`${operation} requires a string path.`);
  return workspacePath(value);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function cancelled(context?: OperationContext): void {
  context?.signal?.throwIfCancelled();
}

export interface ProjectWorkspaceTools {
  readonly stat: StatTool;
  readonly readBytes: ReadBytesTool;
  readonly writeBytes: WriteBytesTool;
  readonly createDirectory: CreateDirectoryTool;
  readonly move: MoveTool;
  readonly remove: RemoveTool;
  readonly applyPatch: ReturnType<typeof createStrictApplyPatchTool>;
}

export function createProjectWorkspaceTools(workspace: ProjectWorkspace): ProjectWorkspaceTools {
  const stat: StatTool = Object.freeze({
    name: 'stat',
    description: 'Inspect a workspace file or directory.',
    operation: WORKSPACE_OPERATIONS.stat,
    async execute(input: StatInput, context?: OperationContext) {
      const value = record(input, 'stat');
      exactKeys(value, ['path'], 'stat');
      const path = pathValue(value.path, 'stat');
      cancelled(context);
      const entry = await workspace.stat(path, context);
      cancelled(context);
      return Object.freeze({ entry });
    },
  });
  const readBytes: ReadBytesTool = Object.freeze({
    name: 'read_bytes',
    description: 'Read a binary file from the workspace.',
    operation: WORKSPACE_OPERATIONS.readBytes,
    async execute(input: ReadBytesInput, context?: OperationContext) {
      const value = record(input, 'read_bytes');
      exactKeys(value, ['path'], 'read_bytes');
      const path = pathValue(value.path, 'read_bytes');
      cancelled(context);
      const content = Uint8Array.from(await workspace.readBytes(path, context));
      cancelled(context);
      return Object.freeze({ path, content });
    },
  });
  const writeBytes: WriteBytesTool = Object.freeze({
    name: 'write_bytes',
    description: 'Create or replace a binary file in the workspace.',
    operation: WORKSPACE_OPERATIONS.writeBytes,
    async execute(input: WriteBytesInput, context?: OperationContext) {
      const value = record(input, 'write_bytes');
      exactKeys(value, ['path', 'content'], 'write_bytes');
      const path = pathValue(value.path, 'write_bytes');
      if (!(value.content instanceof Uint8Array)) {
        throw new TypeError('write_bytes requires Uint8Array content.');
      }
      cancelled(context);
      const created = await workspace.writeBytes(path, value.content, context);
      cancelled(context);
      return Object.freeze({ path, created });
    },
  });
  const createDirectory: CreateDirectoryTool = Object.freeze({
    name: 'create_directory',
    description: 'Create a workspace directory.',
    operation: WORKSPACE_OPERATIONS.createDirectory,
    async execute(input: CreateDirectoryInput, context?: OperationContext) {
      const value = record(input, 'create_directory');
      exactKeys(value, ['path', 'recursive'], 'create_directory');
      const path = pathValue(value.path, 'create_directory');
      const recursive = optionalBoolean(value.recursive, 'create_directory recursive');
      cancelled(context);
      const created = await workspace.createDirectory(
        path,
        recursive === undefined ? undefined : { recursive },
        context,
      );
      cancelled(context);
      return Object.freeze({ path, created });
    },
  });
  const move: MoveTool = Object.freeze({
    name: 'move',
    description: 'Move or rename a workspace file or directory.',
    operation: WORKSPACE_OPERATIONS.move,
    async execute(input: MoveInput, context?: OperationContext) {
      const value = record(input, 'move');
      exactKeys(value, ['source', 'destination', 'overwrite'], 'move');
      const source = pathValue(value.source, 'move source');
      const destination = pathValue(value.destination, 'move destination');
      const overwrite = optionalBoolean(value.overwrite, 'move overwrite');
      cancelled(context);
      await workspace.move(
        source,
        destination,
        overwrite === undefined ? undefined : { overwrite },
        context,
      );
      cancelled(context);
      return Object.freeze({ source, destination });
    },
  });
  const remove: RemoveTool = Object.freeze({
    name: 'remove',
    description: 'Remove a workspace file or directory.',
    operation: WORKSPACE_OPERATIONS.remove,
    async execute(input: RemoveInput, context?: OperationContext) {
      const value = record(input, 'remove');
      exactKeys(value, ['path', 'recursive'], 'remove');
      const path = pathValue(value.path, 'remove');
      const recursive = optionalBoolean(value.recursive, 'remove recursive');
      cancelled(context);
      await workspace.remove(path, recursive === undefined ? undefined : { recursive }, context);
      cancelled(context);
      return Object.freeze({ path });
    },
  });
  return Object.freeze({
    stat,
    readBytes,
    writeBytes,
    createDirectory,
    move,
    remove,
    applyPatch: createStrictApplyPatchTool(workspace),
  });
}

export function createProjectWorkspaceToolsPlugin(workspace: ProjectWorkspace): LoomPlugin {
  const legacy = createWorkspaceTools(workspace);
  const tools = createProjectWorkspaceTools(workspace);
  return definePlugin({
    manifest: {
      id: PROJECT_WORKSPACE_TOOLS_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      context.capabilities.register(LIST_FILES_TOOL_KEY, legacy[0]);
      context.capabilities.register(READ_FILE_TOOL_KEY, legacy[1]);
      context.capabilities.register(WRITE_FILE_TOOL_KEY, legacy[2]);
      context.capabilities.register(STAT_TOOL_KEY, tools.stat);
      context.capabilities.register(READ_BYTES_TOOL_KEY, tools.readBytes);
      context.capabilities.register(WRITE_BYTES_TOOL_KEY, tools.writeBytes);
      context.capabilities.register(CREATE_DIRECTORY_TOOL_KEY, tools.createDirectory);
      context.capabilities.register(MOVE_TOOL_KEY, tools.move);
      context.capabilities.register(REMOVE_TOOL_KEY, tools.remove);
      context.capabilities.register(APPLY_PATCH_TOOL_KEY, tools.applyPatch);
    },
  });
}
