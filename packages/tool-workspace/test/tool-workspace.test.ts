import { describe, expect, it, vi } from 'vitest';

import {
  LIST_FILES_TOOL_KEY,
  READ_FILE_TOOL_KEY,
  WORKSPACE_OPERATIONS,
  WORKSPACE_TOOL_CAPABILITY_IDS,
  WORKSPACE_TOOLS_PLUGIN_ID,
  WRITE_FILE_TOOL_KEY,
  createWorkspaceToolsPlugin,
  isWorkspacePath,
  workspacePath,
  type ListFilesTool,
  type ReadFileTool,
  type TextWorkspace,
  type WorkspaceTool,
  type WriteFileTool,
} from '../src/index.js';
import {
  type CapabilityKey,
  type OperationContext,
  type PluginInitializeContext,
  type Tool,
} from '@loom/plugin-api';
import { createCancellationSource, systemClock } from '@loom/types';

function fakeWorkspace(overrides: Partial<TextWorkspace> = {}): TextWorkspace {
  return {
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => true,
    ...overrides,
  };
}

async function initializeTools(workspace: TextWorkspace): Promise<readonly WorkspaceTool[]> {
  const values: WorkspaceTool[] = [];
  const plugin = createWorkspaceToolsPlugin({ workspace });
  const capabilities = {
    register<Capability>(key: CapabilityKey<Capability>, value: Capability) {
      expect(key.kind).toBe('tool');
      values.push(value as WorkspaceTool);
    },
  };
  await plugin.initialize?.({
    pluginId: WORKSPACE_TOOLS_PLUGIN_ID,
    configuration: Object.freeze({}),
    clock: systemClock,
    events: {
      on: () => () => undefined,
      emit: async () => undefined,
    },
    capabilities,
    services: {},
  } as unknown as PluginInitializeContext);
  return values;
}

describe('workspace paths', () => {
  it('accepts normalized workspace-relative paths', () => {
    expect(workspacePath('src/index.ts')).toBe('src/index.ts');
    expect(isWorkspacePath('README.md')).toBe(true);
    expect(isWorkspacePath('files/ümlaut name.txt')).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '/root',
    'C:/root',
    'src\\file',
    'src//file',
    'src/./file',
    'src/../file',
  ])('rejects non-normalized path %j', (value) => {
    expect(isWorkspacePath(value)).toBe(false);
    expect(() => workspacePath(value)).toThrow(TypeError);
  });
});

describe('workspace tools plugin', () => {
  it('exports stable typed identities and registers exactly three tools', async () => {
    const tools = await initializeTools(fakeWorkspace());

    expect(WORKSPACE_TOOLS_PLUGIN_ID).toBe('loom/workspace-tools');
    expect(WORKSPACE_TOOL_CAPABILITY_IDS).toEqual({
      listFiles: 'loom/workspace-list-files',
      readFile: 'loom/workspace-read-file',
      writeFile: 'loom/workspace-write-file',
    });
    expect([LIST_FILES_TOOL_KEY.id, READ_FILE_TOOL_KEY.id, WRITE_FILE_TOOL_KEY.id]).toEqual(
      Object.values(WORKSPACE_TOOL_CAPABILITY_IDS),
    );
    expect(tools.map((tool) => tool.operation)).toEqual([
      WORKSPACE_OPERATIONS.listFiles,
      WORKSPACE_OPERATIONS.readFile,
      WORKSPACE_OPERATIONS.writeFile,
    ]);
  });

  it('lists immediate entries in deterministic order and freezes its output', async () => {
    const context: OperationContext = Object.freeze({});
    const listFiles = vi.fn<TextWorkspace['listFiles']>(async () => [
      { path: workspacePath('src/z.ts'), kind: 'file' },
      { path: workspacePath('src/a'), kind: 'directory' },
    ]);
    const [tool] = await initializeTools(fakeWorkspace({ listFiles }));
    const output = await (tool as ListFilesTool).execute({ path: workspacePath('src') }, context);

    expect(listFiles).toHaveBeenCalledWith('src', context);
    expect(output.entries.map((entry) => entry.path)).toEqual(['src/a', 'src/z.ts']);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.entries)).toBe(true);
    expect(output.entries.every(Object.isFrozen)).toBe(true);
  });

  it('reads and writes text while preserving operation context', async () => {
    const context: OperationContext = Object.freeze({});
    const readFile = vi.fn<TextWorkspace['readFile']>(async () => 'hello');
    const writeFile = vi.fn<TextWorkspace['writeFile']>(async () => false);
    const tools = await initializeTools(fakeWorkspace({ readFile, writeFile }));
    const read = tools[1] as ReadFileTool;
    const write = tools[2] as WriteFileTool;

    const readOutput = await read.execute({ path: workspacePath('README.md') }, context);
    const writeOutput = await write.execute(
      { path: workspacePath('README.md'), content: 'updated' },
      context,
    );

    expect(readFile).toHaveBeenCalledWith('README.md', context);
    expect(writeFile).toHaveBeenCalledWith('README.md', 'updated', context);
    expect(readOutput).toEqual({ path: 'README.md', content: 'hello' });
    expect(writeOutput).toEqual({ path: 'README.md', created: false });
    expect(Object.isFrozen(readOutput)).toBe(true);
    expect(Object.isFrozen(writeOutput)).toBe(true);
  });

  it('validates runtime inputs before invoking the adapter', async () => {
    const readFile = vi.fn<TextWorkspace['readFile']>(async () => 'unused');
    const writeFile = vi.fn<TextWorkspace['writeFile']>(async () => true);
    const tools = await initializeTools(fakeWorkspace({ readFile, writeFile }));
    const list = tools[0] as unknown as Tool<unknown, unknown>;
    const read = tools[1] as unknown as Tool<unknown, unknown>;
    const write = tools[2] as unknown as Tool<unknown, unknown>;

    await expect(list.execute({ path: '.' })).rejects.toThrow(TypeError);
    await expect(list.execute({ unexpected: true })).rejects.toThrow(TypeError);
    await expect(read.execute({})).rejects.toThrow(TypeError);
    await expect(write.execute({ path: 'file.txt', content: 42 })).rejects.toThrow(TypeError);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('honors cancellation before adapter invocation', async () => {
    const readFile = vi.fn<TextWorkspace['readFile']>(async () => 'unused');
    const tools = await initializeTools(fakeWorkspace({ readFile }));
    const cancellation = createCancellationSource();
    cancellation.cancel('stop');

    await expect(
      (tools[1] as ReadFileTool).execute(
        { path: workspacePath('README.md') },
        { signal: cancellation.signal },
      ),
    ).rejects.toThrow('Operation cancelled');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects malformed adapter results', async () => {
    const nested = fakeWorkspace({
      listFiles: async () => [{ path: workspacePath('src/nested/file.ts'), kind: 'file' }],
    });
    const duplicate = fakeWorkspace({
      listFiles: async () => [
        { path: workspacePath('one'), kind: 'file' },
        { path: workspacePath('one'), kind: 'file' },
      ],
    });

    const nestedTool = (await initializeTools(nested))[0] as ListFilesTool;
    const duplicateTool = (await initializeTools(duplicate))[0] as ListFilesTool;
    await expect(nestedTool.execute({ path: workspacePath('src') })).rejects.toThrow(
      'not an immediate child',
    );
    await expect(duplicateTool.execute({})).rejects.toThrow('duplicate entry');
  });

  it('requires a complete TextWorkspace adapter', () => {
    expect(() => createWorkspaceToolsPlugin({ workspace: {} as TextWorkspace })).toThrow(TypeError);
  });
});
