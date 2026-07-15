import type { Page, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Localhost is a potentially trustworthy origin, which enables OPFS in Chromium.
export const browserOrigin = 'http://localhost:4173';
export const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const packageEntries = Object.freeze({
  '@loom/types': '/packages/types/dist/index.js',
  '@loom/plugin-api': '/packages/plugin-api/dist/index.js',
  '@loom/core': '/packages/core/dist/index.js',
  '@loom/tool-workspace': '/packages/tool-workspace/dist/index.js',
  '@loom/agent-codex': '/packages/agent-codex/dist/index.js',
  '@loom/platform-browser': '/packages/platform-browser/dist/index.js',
  '@loom/storage-indexeddb': '/packages/storage-indexeddb/dist/index.js',
  '@loom/workspace-fsa': '/packages/workspace-fsa/dist/index.js',
  '@loom/credential-broker-api': '/packages/credential-broker-api/dist/index.js',
  '@loom/auth-extension': '/packages/auth-extension/dist/index.js',
  '@loom/extension': '/packages/extension/dist/index.js',
  '@loom/examples': '/packages/examples/dist/index.js',
});

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8';

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  '.html': HTML_CONTENT_TYPE,
  '.js': JAVASCRIPT_CONTENT_TYPE,
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

function resolveWorkspaceAsset(pathname: string): string | undefined {
  if (!pathname.startsWith('/packages/') || !pathname.includes('/dist/')) return undefined;
  const relative = normalize(decodeURIComponent(pathname).slice(1));
  const absolute = join(workspaceRoot, relative);
  const packagesRoot = join(workspaceRoot, 'packages') + sep;
  return absolute.startsWith(packagesRoot) ? absolute : undefined;
}

function resolveBrowserExampleAsset(pathname: string): string | undefined {
  const relative =
    pathname === '/example-browser/' || pathname === '/example-browser/index.html'
      ? 'index.html'
      : pathname.startsWith('/example-browser/')
        ? normalize(decodeURIComponent(pathname).slice('/example-browser/'.length))
        : undefined;
  if (relative === undefined) return undefined;
  const exampleRoot = join(workspaceRoot, 'packages', 'example-browser');
  const absolute = join(exampleRoot, relative);
  return absolute === join(exampleRoot, 'index.html') || absolute.startsWith(exampleRoot + sep)
    ? absolute
    : undefined;
}

function resolveExtensionExampleAsset(pathname: string): string | undefined {
  const relative =
    pathname === '/example-extension/' || pathname === '/example-extension/index.html'
      ? 'index.html'
      : pathname.startsWith('/example-extension/')
        ? normalize(decodeURIComponent(pathname).slice('/example-extension/'.length))
        : undefined;
  if (relative === undefined) return undefined;
  const exampleRoot = join(workspaceRoot, 'packages', 'example-extension');
  const absolute = join(exampleRoot, relative);
  return absolute === join(exampleRoot, 'index.html') || absolute.startsWith(exampleRoot + sep)
    ? absolute
    : undefined;
}

function resolveBareWorkspaceImports(source: string): string {
  let resolved = source;
  for (const [specifier, pathname] of Object.entries(packageEntries)) {
    resolved = resolved.replaceAll(`'${specifier}'`, `'${browserOrigin}${pathname}'`);
    resolved = resolved.replaceAll(`"${specifier}"`, `"${browserOrigin}${pathname}"`);
  }
  return resolved;
}

const workerSource = `
import { createLoomRuntime } from '${browserOrigin}/packages/core/dist/index.js';
import { authKey } from '${browserOrigin}/packages/plugin-api/dist/index.js';
import {
  createAllCapabilitiesPlugin,
  EXAMPLE_CAPABILITY_IDS,
} from '${browserOrigin}/packages/examples/dist/index.js';

self.onmessage = async () => {
  let runtime;
  try {
    runtime = createLoomRuntime({ plugins: [createAllCapabilitiesPlugin()] });
    await runtime.initialize();
    await runtime.start();
    const token = await runtime.capabilities
      .get(authKey(EXAMPLE_CAPABILITY_IDS.auth))
      .getAccessToken();
    const capabilityCount = runtime.capabilities.list().length;
    await runtime.stop();
    await runtime.dispose();
    self.postMessage({ ok: true, state: runtime.state, token, capabilityCount });
  } catch (error) {
    if (runtime !== undefined) {
      try { await runtime.dispose(); } catch {}
    }
    self.postMessage({
      ok: false,
      error: error instanceof Error ? String(error.stack ?? error.message) : String(error),
    });
  }
};
`;

const phaseTwoWorkerSource = `
import { createLoomRuntime } from '${browserOrigin}/packages/core/dist/index.js';
import { sessionId } from '${browserOrigin}/packages/types/dist/index.js';
import {
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  createCodexAgentPlugin,
} from '${browserOrigin}/packages/agent-codex/dist/index.js';
import {
  LIST_FILES_TOOL_KEY,
  READ_FILE_TOOL_KEY,
  WRITE_FILE_TOOL_KEY,
  createWorkspaceToolsPlugin,
} from '${browserOrigin}/packages/tool-workspace/dist/index.js';
import {
  EXAMPLE_CODEX_MODEL_KEY,
  EXAMPLE_CODEX_SESSION_CONFIGURATION,
  createInMemoryTextWorkspace,
  createScriptedCodexModelPlugin,
} from '${browserOrigin}/packages/examples/dist/index.js';

self.onmessage = async () => {
  let runtime;
  try {
    const workspace = createInMemoryTextWorkspace();
    runtime = createLoomRuntime({
      plugins: [
        createScriptedCodexModelPlugin(),
        createWorkspaceToolsPlugin({ workspace }),
        createCodexAgentPlugin(),
      ],
      configuration: { [CODEX_AGENT_PLUGIN_ID]: { maxTurns: 1 } },
    });
    await runtime.initialize();
    await runtime.start();
    const session = await runtime.sessions.create({
      id: sessionId('phase-two-worker'),
      configuration: {
        [CODEX_AGENT_PLUGIN_ID]: EXAMPLE_CODEX_SESSION_CONFIGURATION,
      },
    });
    const agent = await runtime.capabilities.get(CODEX_AGENT_KEY).create({
      model: runtime.capabilities.get(EXAMPLE_CODEX_MODEL_KEY),
      tools: [
        runtime.capabilities.get(LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(READ_FILE_TOOL_KEY),
        runtime.capabilities.get(WRITE_FILE_TOOL_KEY),
      ],
      configuration: session.configuration[CODEX_AGENT_PLUGIN_ID],
    });
    const events = [];
    for await (const event of agent.run(
      { prompt: 'Process source.txt.' },
      { signal: session.signal, sessionId: session.metadata.id },
    )) events.push(event);
    await session.close();
    const sessionsAfterClose = runtime.sessions.list().length;
    await runtime.stop();
    await runtime.dispose();
    self.postMessage({
      ok: true,
      state: runtime.state,
      operations: events.filter((event) => event.type === 'tool-start').map((event) => event.operation),
      files: workspace.snapshot(),
      trace: workspace.invocations(),
      sessionsAfterClose,
    });
  } catch (error) {
    if (runtime !== undefined) {
      try { await runtime.dispose(); } catch {}
    }
    self.postMessage({
      ok: false,
      error: error instanceof Error ? String(error.stack ?? error.message) : String(error),
    });
  }
};
`;

const phaseThreeWorkerSource = `
import { createLoomRuntime } from '${browserOrigin}/packages/core/dist/index.js';
import { namespacedId, sessionId } from '${browserOrigin}/packages/types/dist/index.js';
import {
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  createCodexAgentPlugin,
} from '${browserOrigin}/packages/agent-codex/dist/index.js';
import {
  BROWSER_PLATFORM_KEY,
  createBrowserPlatformPlugin,
} from '${browserOrigin}/packages/platform-browser/dist/index.js';
import {
  INDEXEDDB_STORAGE_KEY,
  createIndexedDbStoragePlugin,
} from '${browserOrigin}/packages/storage-indexeddb/dist/index.js';
import {
  FSA_LIST_FILES_TOOL_KEY,
  FSA_READ_FILE_TOOL_KEY,
  FSA_WRITE_FILE_TOOL_KEY,
  createFileSystemAccessWorkspacePlugin,
} from '${browserOrigin}/packages/workspace-fsa/dist/index.js';
import {
  EXAMPLE_CODEX_MODEL_KEY,
  createScriptedCodexModelPlugin,
} from '${browserOrigin}/packages/examples/dist/index.js';

function deleteDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB deletion was blocked.'));
  });
}

self.onmessage = async () => {
  let runtime;
  const suffix = String(Date.now()) + '-' + String(Math.random()).slice(2);
  const databaseName = 'loom-phase-three-worker-' + suffix;
  const directoryName = 'loom-phase-three-worker-' + suffix;
  let storageRoot;
  try {
    storageRoot = await navigator.storage.getDirectory();
    const directory = await storageRoot.getDirectoryHandle(directoryName, { create: true });
    const source = await directory.getFileHandle('source.txt', { create: true });
    const writable = await source.createWritable();
    await writable.write('hello Loom');
    await writable.close();

    runtime = createLoomRuntime({
      plugins: [
        createBrowserPlatformPlugin({ scope: 'dedicated-worker', indexedDB }),
        createIndexedDbStoragePlugin({ indexedDB, databaseName }),
        createFileSystemAccessWorkspacePlugin(directory),
        createScriptedCodexModelPlugin(),
        createCodexAgentPlugin(),
      ],
      configuration: { [CODEX_AGENT_PLUGIN_ID]: { maxTurns: 4 } },
    });
    await runtime.initialize();
    await runtime.start();

    const platform = runtime.capabilities.get(BROWSER_PLATFORM_KEY);
    const storage = runtime.capabilities.get(INDEXEDDB_STORAGE_KEY);
    const namespace = namespacedId('loom-test/phase-three-worker');
    const input = new Uint8Array([1, 2, 3]);
    await storage.set(namespace, 'worker', input);
    input[0] = 9;
    const stored = [...(await storage.get(namespace, 'worker') ?? [])];
    const keys = await storage.list(namespace);
    const deleted = await storage.delete(namespace, 'worker');

    const session = await runtime.sessions.create({ id: sessionId('phase-three-worker') });
    const agent = await runtime.capabilities.get(CODEX_AGENT_KEY).create({
      model: runtime.capabilities.get(EXAMPLE_CODEX_MODEL_KEY),
      tools: [
        runtime.capabilities.get(FSA_LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(FSA_READ_FILE_TOOL_KEY),
        runtime.capabilities.get(FSA_WRITE_FILE_TOOL_KEY),
      ],
      configuration: session.configuration[CODEX_AGENT_PLUGIN_ID],
    });
    const events = [];
    for await (const event of agent.run(
      { prompt: 'Process source.txt.' },
      { signal: session.signal, sessionId: session.metadata.id },
    )) events.push(event);
    const resultFile = await directory.getFileHandle('result.txt');
    const resultText = await (await resultFile.getFile()).text();
    await session.close();
    await runtime.stop();
    await runtime.dispose();

    let closedCode;
    try { await storage.get(namespace, 'worker'); } catch (error) { closedCode = error?.code; }
    await deleteDatabase(databaseName);
    await storageRoot.removeEntry(directoryName, { recursive: true });
    self.postMessage({
      ok: true,
      state: runtime.state,
      scope: platform.scope,
      stored,
      keys,
      deleted,
      resultText,
      operations: events.filter((event) => event.type === 'tool-start').map((event) => event.operation),
      sessionCancelled: session.signal.cancelled,
      closedCode,
    });
  } catch (error) {
    if (runtime !== undefined) {
      try { await runtime.dispose(); } catch {}
    }
    self.postMessage({
      ok: false,
      error: error instanceof Error ? String(error.stack ?? error.message) : String(error),
    });
  }
};
`;

async function routeBuiltAssets(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/' || url.pathname === '/index.html') {
    await route.fulfill({
      status: 200,
      contentType: HTML_CONTENT_TYPE,
      body: '<!doctype html><meta charset="utf-8"><title>Loom ESM smoke test</title>',
    });
    return;
  }
  if (url.pathname === '/worker.js') {
    await route.fulfill({
      status: 200,
      contentType: JAVASCRIPT_CONTENT_TYPE,
      body: workerSource,
    });
    return;
  }
  if (url.pathname === '/phase-two-worker.js') {
    await route.fulfill({
      status: 200,
      contentType: JAVASCRIPT_CONTENT_TYPE,
      body: phaseTwoWorkerSource,
    });
    return;
  }
  if (url.pathname === '/phase-three-worker.js') {
    await route.fulfill({
      status: 200,
      contentType: JAVASCRIPT_CONTENT_TYPE,
      body: phaseThreeWorkerSource,
    });
    return;
  }

  const asset = resolveWorkspaceAsset(url.pathname);
  const exampleAsset = resolveBrowserExampleAsset(url.pathname);
  const extensionExampleAsset = resolveExtensionExampleAsset(url.pathname);
  const resolvedAsset = asset ?? exampleAsset ?? extensionExampleAsset;
  if (resolvedAsset === undefined) {
    await route.fulfill({ status: 404, body: 'Not found' });
    return;
  }

  try {
    const body = await readFile(resolvedAsset, 'utf8');
    await route.fulfill({
      status: 200,
      contentType: contentTypes[extname(resolvedAsset)] ?? 'application/octet-stream',
      body:
        asset !== undefined && extname(resolvedAsset) === '.js'
          ? resolveBareWorkspaceImports(body)
          : body,
    });
  } catch {
    await route.fulfill({ status: 404, body: 'Built asset not found' });
  }
}

export async function openBuiltEsmHarness(page: Page): Promise<void> {
  await page.context().route(`${browserOrigin}/**`, routeBuiltAssets);
  await page.goto(`${browserOrigin}/index.html`);
}
