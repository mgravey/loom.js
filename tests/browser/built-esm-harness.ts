import type { Page, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const browserOrigin = 'http://loom.test';
export const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const packageEntries = Object.freeze({
  '@loom/types': '/packages/types/dist/index.js',
  '@loom/plugin-api': '/packages/plugin-api/dist/index.js',
  '@loom/core': '/packages/core/dist/index.js',
  '@loom/tool-workspace': '/packages/tool-workspace/dist/index.js',
  '@loom/agent-codex': '/packages/agent-codex/dist/index.js',
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

  const asset = resolveWorkspaceAsset(url.pathname);
  if (asset === undefined) {
    await route.fulfill({ status: 404, body: 'Not found' });
    return;
  }

  try {
    const body = await readFile(asset, 'utf8');
    await route.fulfill({
      status: 200,
      contentType: contentTypes[extname(asset)] ?? 'application/octet-stream',
      body: extname(asset) === '.js' ? resolveBareWorkspaceImports(body) : body,
    });
  } catch {
    await route.fulfill({ status: 404, body: 'Built asset not found' });
  }
}

export async function openBuiltEsmHarness(page: Page): Promise<void> {
  await page.context().route(`${browserOrigin}/**`, routeBuiltAssets);
  await page.goto(`${browserOrigin}/index.html`);
}
