import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness, workspaceRoot } from './built-esm-harness.js';

const extensionPath = join(workspaceRoot, 'packages', 'extension-codex-experimental', 'dist');
const providerId = 'openai/codex-experimental';
const refreshKey = `loom.refresh-credential.${encodeURIComponent(providerId)}`;
const accountKey = 'loom.codex-experimental.chatgpt-account-id';

function idToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

async function launchExtension(): Promise<{
  readonly context: BrowserContext;
  readonly extensionId: string;
}> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).hostname };
}

test('runs the browser app through the credential and model extension boundary', async () => {
  const verifier = Buffer.alloc(64, 11).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const modelRequests: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }[] = [];
  const { context, extensionId } = await launchExtension();

  try {
    await context.route('https://auth.openai.com/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {
        'access-control-allow-origin': '*',
        'content-type': 'application/json; charset=utf-8',
      };
      if (url.pathname === '/api/accounts/deviceauth/usercode') {
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify({
            device_auth_id: 'vertical-slice-device',
            user_code: 'LOOM-RUN',
            interval: '0.01',
          }),
        });
        return;
      }
      if (url.pathname === '/api/accounts/deviceauth/token') {
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify({
            authorization_code: 'vertical-slice-code',
            code_verifier: verifier,
            code_challenge: challenge,
          }),
        });
        return;
      }
      if (url.pathname === '/oauth/token') {
        const refresh = (request.postData() ?? '').includes('refresh_token');
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify(
            refresh
              ? { access_token: 'vertical-refreshed-access', expires_in: 60 }
              : {
                  id_token: idToken('vertical-account'),
                  access_token: 'vertical-initial-access',
                  refresh_token: 'vertical-refresh-token',
                  expires_in: 60,
                },
          ),
        });
        return;
      }
      await route.abort('blockedbyclient');
    });

    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const request = route.request();
      const body = request.postData() ?? '';
      modelRequests.push({ body, headers: request.headers() });
      const turn = modelRequests.length;
      const events =
        turn === 1
          ? [
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'function_call',
                  id: 'item-list',
                  call_id: 'call-list',
                  name: 'loom_0_workspace_list-files',
                  arguments: '{}',
                },
              },
              { type: 'response.completed' },
            ]
          : [
              {
                type: 'response.output_text.delta',
                delta: 'The selected workspace contains source.txt.',
              },
              { type: 'response.completed' },
            ];
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
      });
    });

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#enabled').check();
    await options.getByRole('button', { name: 'Use device-code fallback' }).click();
    await expect(options.locator('#status')).toHaveText(/Authorization complete/);
    await expect(options.locator('#credential-status')).toHaveText(/Authenticated/);

    const application = await context.newPage();
    await application.addInitScript(() => {
      Object.defineProperty(globalThis, 'showDirectoryPicker', {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle('loom-codex-vertical-slice', {
            create: true,
          });
          const source = await directory.getFileHandle('source.txt', { create: true });
          const writable = await source.createWritable();
          await writable.write('browser-native Loom workspace');
          await writable.close();
          return directory;
        },
      });
    });
    await openBuiltEsmHarness(application);
    await application.goto(`${browserOrigin}/example-codex-experimental/workbench.html`);
    await application.getByLabel('Experimental extension ID').fill(extensionId);
    await application.getByRole('button', { name: 'Check authentication' }).click();
    await expect(application.getByRole('status')).toHaveText(/^Authenticated\./u);
    await application.getByRole('button', { name: 'Choose directory and run' }).click();
    await expect(application.getByRole('status')).toHaveText('Run complete.');
    const experimentLog = application.getByRole('log', {
      name: 'Codex experiment event log',
    });
    await expect(experimentLog).toContainText('Tool started: workspace/list-files');
    await expect(experimentLog).toContainText('The selected workspace contains source.txt.');

    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.headers.authorization).toBe('Bearer vertical-refreshed-access');
    expect(modelRequests[0]?.headers['chatgpt-account-id']).toBe('vertical-account');
    expect(modelRequests[0]?.headers.originator).toBe('loom_extension_experiment');
    expect(modelRequests[1]?.body).toContain('function_call_output');
    expect(modelRequests[1]?.body).toContain('source.txt');
    expect(await application.locator('body').innerText()).not.toMatch(
      /vertical-(?:refresh|initial|refreshed)-/u,
    );

    await application.getByRole('button', { name: 'Log out extension credential' }).click();
    await expect(application.getByRole('status')).toHaveText(/^Not authenticated\./u);
    const stored = await options.evaluate(
      async ({ refreshStorageKey, accountStorageKey }) => {
        const storage = (
          globalThis as typeof globalThis & {
            readonly chrome: {
              readonly storage: {
                readonly session: {
                  get(keys: readonly string[]): Promise<Record<string, unknown>>;
                };
              };
            };
          }
        ).chrome.storage.session;
        return storage.get([refreshStorageKey, accountStorageKey]);
      },
      { refreshStorageKey: refreshKey, accountStorageKey: accountKey },
    );
    expect(stored).toEqual({});
  } finally {
    await context.close();
  }
});
