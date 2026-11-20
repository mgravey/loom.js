import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

import { workspaceRoot } from './built-esm-harness.js';

test('Google subscription experiment signs in locally, checks access and clears sign-in', async () => {
  const extensionPath = await mkdtemp(join(tmpdir(), 'loom-google-account-'));
  await cp(join(workspaceRoot, 'packages/extension-codex-experimental/dist'), extensionPath, {
    recursive: true,
  });
  const path = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as {
    permissions: string[];
    host_permissions: string[];
    oauth2?: unknown;
  };
  manifest.permissions.push('identity');
  manifest.host_permissions.push('https://cloudcode-pa.googleapis.com/*');
  manifest.oauth2 = {
    client_id: 'loom-fixture.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  };
  await writeFile(path, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const generations: string[] = [];
  let checks = 0;
  try {
    await context.route('https://cloudcode-pa.googleapis.com/**', async (route) => {
      expect(route.request().headers().authorization).toBe('Bearer fixture-google-token');
      if (route.request().url().endsWith(':loadCodeAssist')) {
        checks += 1;
        await route.fulfill({
          json: { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'managed-fixture' },
        });
      } else {
        expect(route.request().url()).toBe(
          'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
        );
        generations.push(route.request().postData() ?? '');
        const first = generations.length === 1;
        await route.fulfill({
          json: {
            response: {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: first
                      ? [
                          {
                            functionCall: { name: 'loom_0_workspace_list-files', args: {} },
                            thoughtSignature: 'subscription-signature',
                          },
                        ]
                      : [{ text: 'Subscription fixture complete.' }],
                  },
                },
              ],
            },
          },
        });
      }
    });
    const installIdentityFixture = () => {
      const host = globalThis as unknown as {
        chrome?: {
          identity?: {
            getAuthToken: (options: { interactive: boolean }) => Promise<unknown>;
            clearAllCachedAuthTokens: () => Promise<void>;
          };
        };
      };
      if (!host.chrome?.identity) return;
      host.chrome.identity.getAuthToken = async () => ({
        token: 'fixture-google-token',
        grantedScopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      host.chrome.identity.clearAllCachedAuthTokens = async () => undefined;
    };
    await context.addInitScript(installIdentityFixture);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await worker.evaluate(installIdentityFixture);
    const extensionId = new URL(worker.url()).hostname;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#server-provider').selectOption('gemini-subscription');
    await expect(options.locator('#responses-endpoint')).toHaveValue(
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
    );
    await expect(options.locator('#responses-api-key')).toBeDisabled();
    await options.locator('#responses-connection-id').fill('google-login');
    await options.locator('#responses-connection-label').fill('Google account');
    await options.locator('#google-subscription-models').fill('gemini-fixture');
    await options.locator('#responses-save').click();
    await expect(options.locator('#responses-status')).toContainText('Code Assist access checked.');
    expect(checks).toBeGreaterThanOrEqual(1);
    const stored = await worker.evaluate(async () => {
      const host = globalThis as unknown as {
        chrome: {
          storage: {
            local: { get: (key: string) => Promise<unknown> };
            session: { get: (key: string) => Promise<unknown> };
          };
        };
      };
      return JSON.stringify([
        await host.chrome.storage.local.get('loom.responses-connections.v1'),
        await host.chrome.storage.session.get('loom.google-subscription.authorized'),
      ]);
    });
    expect(stored).not.toContain('fixture-google-token');
    await options.locator('#google-subscription-logout').click();
    await expect(options.locator('#responses-status')).toContainText('Google sign-in cleared');
    expect(generations).toHaveLength(0);
  } finally {
    await context.close();
    await rm(extensionPath, { recursive: true, force: true });
  }
});

test('Claude account selector pairs with a local helper and retains API-key providers', async () => {
  const calls: string[] = [];
  const pairing = 'fixture_only_pairing_token_1234567890';
  const server = createServer((req, res) => {
    calls.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${pairing}`) res.statusCode = 401;
    res.end(
      JSON.stringify(
        req.url === '/v1/models' ? { data: [{ id: 'sonnet' }] } : { authenticated: true },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const extensionPath = await mkdtemp(join(tmpdir(), 'loom-claude-extension-'));
  await cp(join(workspaceRoot, 'packages/extension-codex-experimental/dist'), extensionPath, {
    recursive: true,
  });
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    await options.locator('#server-provider').selectOption('claude-code');
    await expect(options.locator('#claude-account-fields')).toBeVisible();
    await expect(options.locator('#server-key-label')).toHaveText('Helper pairing token');
    await options.locator('#responses-endpoint').fill(`http://127.0.0.1:${address.port}/v1/`);
    await options.locator('#responses-api-key').fill(pairing);
    await options.locator('#claude-account-login').click();
    await expect.poll(() => calls.includes('/v1/auth/login')).toBe(true);
    await expect(options.locator('#claude-account-login')).toBeEnabled();
    await options.locator('#responses-connection-id').fill('claude-account');
    await options.locator('#responses-connection-label').fill('Claude account');
    await options.locator('#responses-save').click();
    await expect(options.locator('#responses-status')).toContainText(
      'Saved claude-account. Server available: 1 models.',
    );
    await options.locator('#responses-api-key').fill(pairing);
    await options.locator('#claude-account-logout').click();
    await expect.poll(() => calls.includes('/v1/auth/logout')).toBe(true);
    await options.locator('#server-provider').selectOption('anthropic');
    await expect(options.locator('#claude-account-fields')).toBeHidden();
    await expect(options.locator('#server-key-label')).toHaveText('API key (optional)');
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(extensionPath, { recursive: true, force: true });
  }
});
