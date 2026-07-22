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
    'coding',
    'execution-browser',
    'model-openai-responses',
    'platform-browser',
    'storage-indexeddb',
    'workspace-fsa',
    'credential-broker-api',
    'credential-provider-api',
    'auth-extension',
    'extension',
    'auth-codex-experimental',
    'extension-codex-experimental',
    'model-codex-experimental',
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
  expect(declarations.get('coding')).toContain('createCodingSession');
  expect(declarations.get('execution-browser')).toContain('createQuickJsExecutionRuntime');
  expect(declarations.get('model-openai-responses')).toContain('createOpenAIResponsesModelPlugin');
  expect(declarations.get('platform-browser')).toContain('createBrowserPlatformPlugin');
  expect(declarations.get('storage-indexeddb')).toContain('createIndexedDbStoragePlugin');
  expect(declarations.get('workspace-fsa')).toContain('createFileSystemAccessWorkspacePlugin');
  expect(declarations.get('credential-broker-api')).toContain('CredentialBroker');
  expect(declarations.get('credential-provider-api')).toContain('CredentialProvider');
  expect(declarations.get('auth-extension')).toContain('createExtensionAuthPlugin');
  expect(declarations.get('extension')).toContain('createCredentialBrokerMessageHandler');
  expect(declarations.get('auth-codex-experimental')).toContain(
    'createCodexExperimentalDeviceAuthorization',
  );
  expect(declarations.get('extension-codex-experimental')).toContain(
    'createCodexExperimentalExtension',
  );
  expect(declarations.get('model-codex-experimental')).toContain(
    'createCodexExperimentalModelPlugin',
  );
  expect(declarations.get('examples')).toContain('createAllCapabilitiesPlugin');
  expect(declarations.get('examples')).toContain('createInMemoryTextWorkspace');
});

test('built extension assets are installable and self-contained', async () => {
  const extensionDirectory = join(workspaceRoot, 'packages', 'extension', 'dist');
  const manifest = JSON.parse(
    await readFile(join(extensionDirectory, 'manifest.json'), 'utf8'),
  ) as {
    readonly name?: string;
    readonly description?: string;
    readonly icons?: Readonly<Record<string, string>>;
    readonly manifest_version?: number;
    readonly background?: { readonly service_worker?: string };
  };
  const serviceWorker = await readFile(join(extensionDirectory, 'service-worker.js'), 'utf8');

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.background?.service_worker).toBe('service-worker.js');
  expect(serviceWorker).not.toMatch(/\b(?:import|export)\b/u);
  expect(serviceWorker).not.toContain('@mgravey/loom-');
});

test('built experimental extension is isolated, installable, and self-contained', async () => {
  const extensionDirectory = join(
    workspaceRoot,
    'packages',
    'extension-codex-experimental',
    'dist',
  );
  const manifest = JSON.parse(
    await readFile(join(extensionDirectory, 'manifest.json'), 'utf8'),
  ) as {
    readonly name?: string;
    readonly description?: string;
    readonly icons?: Readonly<Record<string, string>>;
    readonly manifest_version?: number;
    readonly permissions?: readonly string[];
    readonly host_permissions?: readonly string[];
    readonly incognito?: string;
    readonly background?: { readonly service_worker?: string };
    readonly options_ui?: { readonly page?: string };
  };
  const serviceWorker = await readFile(join(extensionDirectory, 'service-worker.js'), 'utf8');
  const brandAnimationScript = await readFile(
    join(extensionDirectory, 'brand-animation.js'),
    'utf8',
  );
  const optionsScript = await readFile(join(extensionDirectory, 'options.js'), 'utf8');
  const optionsPage = await readFile(join(extensionDirectory, 'options.html'), 'utf8');
  const callbackPage = await readFile(join(extensionDirectory, 'callback.html'), 'utf8');
  const privacyPage = await readFile(join(extensionDirectory, 'privacy.html'), 'utf8');
  const thirdPartyNotices = await readFile(
    join(extensionDirectory, 'THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  const icon128 = await readFile(join(extensionDirectory, 'icons', 'icon128.png'));

  expect(manifest).toMatchObject({
    manifest_version: 3,
    name: 'Loom.js Companion',
    description:
      'Authenticates Loom sessions and relays model requests only when direct browser access fails.',
    icons: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
    permissions: ['declarativeNetRequest', 'storage'],
    host_permissions: [
      'http://localhost:1455/*',
      'https://auth.openai.com/*',
      'https://chatgpt.com/backend-api/codex/*',
    ],
    incognito: 'not_allowed',
    background: { service_worker: 'service-worker.js' },
    options_ui: { page: 'options.html' },
  });
  for (const bundle of [serviceWorker, brandAnimationScript, optionsScript]) {
    expect(bundle).not.toMatch(/\b(?:import|export)\b/u);
    expect(bundle).not.toContain('@mgravey/loom-');
  }
  expect(privacyPage).toMatch(/Chrome\s+Web Store User Data Policy/u);
  expect(privacyPage).toContain('id="brand-animation"');
  expect(privacyPage).toContain('src="brand-animation.js"');
  expect(optionsPage).toContain('id="brand-animation"');
  expect(optionsPage).toContain('src="icons/icon128.png"');
  expect(callbackPage).toContain('src="icons/icon128.png"');
  expect(callbackPage).toContain('href="icons/icon32.png"');
  expect(thirdPartyNotices).toContain('lottie-web 5.13.0');
  expect(thirdPartyNotices).toContain('The MIT License (MIT)');
  expect(brandAnimationScript).toContain('Reference_Weave_Draw');
  expect(icon128.byteLength).toBeGreaterThan(0);
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
      coding,
      browserExecution,
      openAIResponsesModel,
      browserPlatform,
      indexedDbStorage,
      fileSystemWorkspace,
      credentialBrokerApi,
      credentialProviderApi,
      extensionAuth,
      credentialBrokerExtension,
      experimentalCodexAuth,
      experimentalCodexExtension,
      experimentalCodexModel,
      examples,
    ] = await Promise.all([
      import(`${origin}/packages/types/dist/index.js`),
      import(`${origin}/packages/plugin-api/dist/index.js`),
      import(`${origin}/packages/core/dist/index.js`),
      import(`${origin}/packages/tool-workspace/dist/index.js`),
      import(`${origin}/packages/agent-codex/dist/index.js`),
      import(`${origin}/packages/coding/dist/index.js`),
      import(`${origin}/packages/execution-browser/dist/index.js`),
      import(`${origin}/packages/model-openai-responses/dist/index.js`),
      import(`${origin}/packages/platform-browser/dist/index.js`),
      import(`${origin}/packages/storage-indexeddb/dist/index.js`),
      import(`${origin}/packages/workspace-fsa/dist/index.js`),
      import(`${origin}/packages/credential-broker-api/dist/index.js`),
      import(`${origin}/packages/credential-provider-api/dist/index.js`),
      import(`${origin}/packages/auth-extension/dist/index.js`),
      import(`${origin}/packages/extension/dist/index.js`),
      import(`${origin}/packages/auth-codex-experimental/dist/index.js`),
      import(`${origin}/packages/extension-codex-experimental/dist/index.js`),
      import(`${origin}/packages/model-codex-experimental/dist/index.js`),
      import(`${origin}/packages/examples/dist/index.js`),
    ]);
    return {
      types: Object.keys(types),
      pluginApi: Object.keys(pluginApi),
      core: Object.keys(core),
      workspace: Object.keys(workspace),
      agent: Object.keys(agent),
      coding: Object.keys(coding),
      browserExecution: Object.keys(browserExecution),
      openAIResponsesModel: Object.keys(openAIResponsesModel),
      browserPlatform: Object.keys(browserPlatform),
      indexedDbStorage: Object.keys(indexedDbStorage),
      fileSystemWorkspace: Object.keys(fileSystemWorkspace),
      credentialBrokerApi: Object.keys(credentialBrokerApi),
      credentialProviderApi: Object.keys(credentialProviderApi),
      extensionAuth: Object.keys(extensionAuth),
      credentialBrokerExtension: Object.keys(credentialBrokerExtension),
      experimentalCodexAuth: Object.keys(experimentalCodexAuth),
      experimentalCodexExtension: Object.keys(experimentalCodexExtension),
      experimentalCodexModel: Object.keys(experimentalCodexModel),
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
  expect(exportsByPackage.coding).toContain('createCodingSession');
  expect(exportsByPackage.browserExecution).toEqual(
    expect.arrayContaining([
      'createQuickJsExecutionRuntime',
      'createWebContainerExecutionRuntime',
      'createPyodideExecutionRuntime',
      'executeBrowserWorkspace',
    ]),
  );
  expect(exportsByPackage.openAIResponsesModel).toEqual(
    expect.arrayContaining([
      'OPENAI_RESPONSES_MODEL_KEY',
      'createOpenAIResponsesModel',
      'createOpenAIResponsesModelPlugin',
      'createOpenAIResponsesRequestBody',
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
  expect(exportsByPackage.credentialBrokerApi).toEqual(
    expect.arrayContaining([
      'CREDENTIAL_BROKER_PROTOCOL',
      'createGetAccessTokenRequest',
      'parseCredentialBrokerResponse',
    ]),
  );
  expect(exportsByPackage.credentialProviderApi).toEqual(
    expect.arrayContaining(['CredentialProviderError', 'isCredentialProviderError']),
  );
  expect(exportsByPackage.extensionAuth).toEqual(
    expect.arrayContaining([
      'EXTENSION_AUTH_KEY',
      'createExtensionAuthPlugin',
      'createExternalCredentialBroker',
    ]),
  );
  expect(exportsByPackage.credentialBrokerExtension).toEqual(
    expect.arrayContaining([
      'createCredentialBrokerMessageHandler',
      'createExtensionTokenService',
      'createOriginAuthorizer',
    ]),
  );
  expect(exportsByPackage.experimentalCodexAuth).toEqual(
    expect.arrayContaining([
      'CODEX_CLI_OAUTH_AUDIT_SNAPSHOT',
      'createCodexExperimentalCredentialProvider',
      'createCodexExperimentalDeviceAuthorization',
      'createCodexExperimentalRedirectAuthorization',
    ]),
  );
  expect(exportsByPackage.experimentalCodexExtension).toEqual(
    expect.arrayContaining([
      'createChromeIdentityRedirect',
      'createCodexExperimentalExtension',
      'runManualDeviceAuthorization',
    ]),
  );
  expect(exportsByPackage.experimentalCodexModel).toEqual(
    expect.arrayContaining([
      'CODEX_EXPERIMENTAL_MODEL_KEY',
      'createCodexExperimentalModel',
      'createCodexExperimentalModelPlugin',
      'createCodexResponsesRequestBody',
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
