import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'tsup';

import { workspaceRoot } from './built-esm-harness.js';

/**
 * The built Companion extension lets a public HTTPS website (not 127.0.0.1) run its own
 * "Sign in with ChatGPT". Every OpenAI endpoint is a local fixture; the loopback callback must never
 * be contacted. The optional host permissions are granted in a copied manifest because a headless
 * test cannot accept Chrome's permission prompt.
 */
const SITE = 'https://studio.example.test';
const AUTH = 'https://auth.openai.com';
const CLIENT = 'oaiapp_extension_helper_fixture';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'helper-fixture', alg: 'RS256' };

function identity(nonce: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${encode({
    iss: AUTH,
    aud: CLIENT,
    sub: 'helper-fixture-subject',
    email: 'helper@example.test',
    nonce,
    iat: now,
    exp: now + 3600,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

const pageSource = `
import { createChatGPTBrowserClient, detectChatGPTBrowserSupport } from ${JSON.stringify(
  join(workspaceRoot, 'packages/auth-chatgpt-browser/dist/index.js'),
)};
import { connectCompanionChatGPTHelper } from ${JSON.stringify(
  join(workspaceRoot, 'packages/companion-codex-experimental/dist/index.js'),
)};

globalThis.runHelperScenario = async (extensionId) => {
  const plain = detectChatGPTBrowserSupport();
  const { status, helper } = await connectCompanionChatGPTHelper({
    runtime: () => globalThis.chrome.runtime,
    extensionId,
  });
  if (helper === undefined) return { plain, status };
  const client = createChatGPTBrowserClient({
    appName: 'Helper fixture',
    storage: null,
    ...helper.clientOptions,
  });
  await client.signIn();
  const models = await client.listModels();
  const response = await client.transport.send({
    body: JSON.stringify({ model: models[0].slug, input: [] }),
  });
  let text = '';
  for await (const chunk of response.body) text += chunk;
  const signedIn = client.getStatus();
  client.dispose();
  return { plain, status, signedIn, models, text };
};
globalThis.statusOnly = async (extensionId) =>
  (await connectCompanionChatGPTHelper({ runtime: () => globalThis.chrome.runtime, extensionId }))
    .status;
`;

async function launch(): Promise<{
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly script: string;
  readonly cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'loom-chatgpt-helper-'));
  const extensionPath = join(directory, 'extension');
  await cp(join(workspaceRoot, 'packages/extension-codex-experimental/dist'), extensionPath, {
    recursive: true,
  });
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push('https://api.openai.com/*', 'http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const entry = join(directory, 'page.js');
  await writeFile(entry, pageSource);
  await build({
    entry: [entry],
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    outDir: join(directory, 'bundle'),
    noExternal: [/.*/u],
    silent: true,
    config: false,
  });
  const script = await readFile(join(directory, 'bundle', 'page.js'), 'utf8');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    extensionId: new URL(worker.url()).hostname,
    script,
    cleanup: async () => {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function approve(context: BrowserContext, enabled: boolean): Promise<void> {
  const worker = context.serviceWorkers()[0];
  await worker?.evaluate(
    async ({ site, on }) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(v: unknown): Promise<void> } } };
        }
      ).chrome;
      await chrome.storage.local.set({
        'loom.codex-experimental.approved-origins': [site],
        'loom.chatgpt-helper.enabled': on,
      });
    },
    { site: SITE, on: enabled },
  );
}

test('lets an approved HTTPS website sign in with ChatGPT through the Companion', async () => {
  const { context, extensionId, script, cleanup } = await launch();
  const loopback: string[] = [];
  const pageRequests: string[] = [];
  const authorized: string[] = [];
  let nonce = '';
  try {
    await context.route('http://127.0.0.1:1456/**', async (route) => {
      loopback.push(route.request().url());
      await route.abort();
    });
    await context.route(`${SITE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill(
        path === '/page.js'
          ? { contentType: 'text/javascript', body: script }
          : {
              contentType: 'text/html',
              body: '<!doctype html><meta charset="utf-8"><title>Site</title><script type="module" src="/page.js"></script>',
            },
      );
    });
    await context.route(`${AUTH}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const fromPage = request.serviceWorker() === null && request.headers().origin === SITE;
      if (fromPage) pageRequests.push(url.pathname);
      if (url.pathname === '/api/accounts/authorize') {
        authorized.push(url.searchParams.get('redirect_uri') ?? '');
        nonce = url.searchParams.get('nonce') ?? '';
        const callback = new URL('http://127.0.0.1:1456/auth/callback');
        callback.search = new URLSearchParams({
          code: 'fixture-code',
          state: url.searchParams.get('state') ?? '',
          client_id: CLIENT,
        }).toString();
        await route.fulfill({ status: 302, headers: { location: callback.href } });
        return;
      }
      if (url.pathname === '/api/accounts/oauth/token') {
        // Matches the observed service: the token endpoint is CORS-readable from any origin.
        await route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: {
            access_token: 'fixture-access',
            refresh_token: 'fixture-refresh',
            id_token: identity(nonce),
            scope: SCOPE,
            token_type: 'Bearer',
            expires_in: 3600,
          },
        });
        return;
      }
      // Discovery and JWKS carry no CORS headers, as observed: only the extension can read them.
      if (url.pathname === '/.well-known/openid-configuration') {
        await route.fulfill({ json: { issuer: AUTH, jwks_uri: `${AUTH}/.well-known/jwks.json` } });
        return;
      }
      if (url.pathname === '/.well-known/jwks.json') {
        await route.fulfill({ json: { keys: [jwk] } });
        return;
      }
      await route.abort();
    });
    await context.route('https://api.openai.com/**', async (route) => {
      const request = route.request();
      expect(request.headers().authorization).toBe('Bearer fixture-access');
      expect(request.headers().cookie).toBeUndefined();
      if (request.url().endsWith('/v1/models')) {
        await route.fulfill({
          json: {
            models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {},
        body:
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' })}\r\n\r\n` +
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\r\n\r\n`,
      });
    });

    const page = await context.newPage();
    await page.goto(`${SITE}/app`);
    await page.waitForFunction(() => 'statusOnly' in globalThis);
    expect(
      await page.evaluate(
        (id) => (globalThis as unknown as { statusOnly(id: string): unknown }).statusOnly(id),
        extensionId,
      ),
    ).toEqual({ available: false, reason: 'origin-not-approved' });
    await approve(context, false);
    expect(
      await page.evaluate(
        (id) => (globalThis as unknown as { statusOnly(id: string): unknown }).statusOnly(id),
        extensionId,
      ),
    ).toEqual({ available: false, reason: 'helper-disabled' });
    await approve(context, true);

    const result = await page.evaluate(
      (id) =>
        (
          globalThis as unknown as { runHelperScenario(id: string): Promise<unknown> }
        ).runHelperScenario(id),
      extensionId,
    );
    expect(result).toMatchObject({
      plain: { supported: false, reason: 'origin-not-loopback' },
      status: { available: true, redirectUri: 'http://127.0.0.1:1456/auth/callback' },
      signedIn: { authenticated: true, planEnabled: true },
      models: [{ slug: 'fixture-model', displayName: 'Fixture' }],
    });
    expect((result as { text: string }).text).toContain('Hello');
    expect(authorized).toEqual(['http://127.0.0.1:1456/auth/callback']);
    expect(loopback).toEqual([]);
    // The page itself only exchanged the code; discovery and keys came through the extension.
    expect(pageRequests).toEqual(['/api/accounts/oauth/token']);
    // The sign-in window closed itself.
    await expect
      .poll(() =>
        context
          .pages()
          .map((page) => page.url())
          .filter((url) => url.startsWith('chrome-extension://') || url.startsWith(AUTH)),
      )
      .toEqual([]);
  } finally {
    await cleanup();
  }
});
