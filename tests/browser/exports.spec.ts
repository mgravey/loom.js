import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { browserOrigin, openBuiltEsmHarness, workspaceRoot } from './built-esm-harness.js';

test('built packages publish declaration entry points', async () => {
  const declarations = new Map<string, string>();
  for (const packageName of [
    'types',
    'plugin-api',
    'core',
    'tool-workspace',
    'agent-codex',
    'platform-browser',
    'storage-indexeddb',
    'workspace-fsa',
    'examples',
  ]) {
    const declaration = await readFile(
      join(workspaceRoot, 'packages', packageName, 'dist', 'index.d.ts'),
      'utf8',
    );
    expect(declaration.trim().length, packageName).toBeGreaterThan(0);
    declarations.set(packageName, declaration);
  }
  expect(declarations.get('core')).toContain('createLoomRuntime');
  expect(declarations.get('tool-workspace')).toContain('createWorkspaceToolsPlugin');
  expect(declarations.get('agent-codex')).toContain('createCodexAgentPlugin');
  expect(declarations.get('platform-browser')).toContain('createBrowserPlatformPlugin');
  expect(declarations.get('storage-indexeddb')).toContain('createIndexedDbStoragePlugin');
  expect(declarations.get('workspace-fsa')).toContain('createFileSystemAccessWorkspacePlugin');
  expect(declarations.get('examples')).toContain('createAllCapabilitiesPlugin');
  expect(declarations.get('examples')).toContain('createInMemoryTextWorkspace');
});

test('built ESM packages expose their public runtime APIs', async ({ page }) => {
  await openBuiltEsmHarness(page);

  const exportsByPackage = await page.evaluate(async (origin) => {
    const [
      types,
      pluginApi,
      core,
      workspace,
      agent,
      browserPlatform,
      indexedDbStorage,
      fileSystemWorkspace,
      examples,
    ] = await Promise.all([
      import(`${origin}/packages/types/dist/index.js`),
      import(`${origin}/packages/plugin-api/dist/index.js`),
      import(`${origin}/packages/core/dist/index.js`),
      import(`${origin}/packages/tool-workspace/dist/index.js`),
      import(`${origin}/packages/agent-codex/dist/index.js`),
      import(`${origin}/packages/platform-browser/dist/index.js`),
      import(`${origin}/packages/storage-indexeddb/dist/index.js`),
      import(`${origin}/packages/workspace-fsa/dist/index.js`),
      import(`${origin}/packages/examples/dist/index.js`),
    ]);
    return {
      types: Object.keys(types),
      pluginApi: Object.keys(pluginApi),
      core: Object.keys(core),
      workspace: Object.keys(workspace),
      agent: Object.keys(agent),
      browserPlatform: Object.keys(browserPlatform),
      indexedDbStorage: Object.keys(indexedDbStorage),
      fileSystemWorkspace: Object.keys(fileSystemWorkspace),
      examples: Object.keys(examples),
    };
  }, browserOrigin);

  expect(exportsByPackage.types).toEqual(
    expect.arrayContaining([
      'createCancellationSource',
      'immutableJson',
      'pluginId',
      'semanticVersion',
      'sessionId',
    ]),
  );
  expect(exportsByPackage.pluginApi).toEqual(
    expect.arrayContaining([
      'PLUGIN_API_VERSION',
      'createCapabilityKey',
      'createEventKey',
      'createServiceToken',
      'definePlugin',
      'registerAgent',
      'registerAuth',
      'registerMemory',
      'registerModel',
      'registerPlatform',
      'registerRuntime',
      'registerStorage',
      'registerTool',
      'registerUi',
    ]),
  );
  expect(exportsByPackage.core).toContain('createLoomRuntime');
  expect(exportsByPackage.workspace).toEqual(
    expect.arrayContaining([
      'LIST_FILES_TOOL_KEY',
      'READ_FILE_TOOL_KEY',
      'WRITE_FILE_TOOL_KEY',
      'createWorkspaceToolsPlugin',
      'workspacePath',
    ]),
  );
  expect(exportsByPackage.agent).toEqual(
    expect.arrayContaining([
      'CODEX_AGENT_KEY',
      'createCodexAgentFactory',
      'createCodexAgentPlugin',
    ]),
  );
  expect(exportsByPackage.browserPlatform).toEqual(
    expect.arrayContaining(['BROWSER_PLATFORM_KEY', 'createBrowserPlatformPlugin']),
  );
  expect(exportsByPackage.indexedDbStorage).toEqual(
    expect.arrayContaining(['INDEXEDDB_STORAGE_KEY', 'createIndexedDbStoragePlugin']),
  );
  expect(exportsByPackage.fileSystemWorkspace).toEqual(
    expect.arrayContaining([
      'FSA_LIST_FILES_TOOL_KEY',
      'FSA_READ_FILE_TOOL_KEY',
      'FSA_WRITE_FILE_TOOL_KEY',
      'createFileSystemAccessWorkspacePlugin',
    ]),
  );
  expect(exportsByPackage.examples).toEqual(
    expect.arrayContaining([
      'EXAMPLE_CAPABILITY_IDS',
      'EXAMPLE_PLUGIN_ID',
      'EXAMPLE_STATUS_SERVICE',
      'EXAMPLE_CODEX_MODEL_KEY',
      'createAllCapabilitiesPlugin',
      'createInMemoryTextWorkspace',
      'createScriptedCodexModelPlugin',
    ]),
  );
});
