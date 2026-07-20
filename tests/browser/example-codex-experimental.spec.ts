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

test('keeps using the extension relay after one direct connection failure', async () => {
  const verifier = Buffer.alloc(64, 11).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const modelRequests: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly frameUrl: string;
  }[] = [];
  let directFailures = 0;
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
      const corsHeaders = {
        'access-control-allow-origin': browserOrigin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers':
          'authorization, chatgpt-account-id, content-type, originator, session-id, thread-id, version, x-openai-internal-codex-responses-lite',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      let frameUrl = 'extension-service-worker';
      try {
        frameUrl = request.frame().url();
      } catch {
        // Extension service-worker fetches are intentionally frameless.
      }
      if (frameUrl.includes('/workbench.html') && directFailures === 0) {
        directFailures += 1;
        await route.abort('failed');
        return;
      }
      const body = request.postData() ?? '';
      modelRequests.push({ body, headers: request.headers(), frameUrl });
      const turn = modelRequests.length;
      if (turn === 3) await new Promise((resolve) => setTimeout(resolve, 200));
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
                delta:
                  turn === 3
                    ? 'A detailed coding response remains readable while the composer stays fixed.\n'.repeat(
                        180,
                      )
                    : 'The selected workspace contains **source.txt**.\n\n```text\nOriginal array: [1 2 3 4 5]\nMean: 3.0\n```\n\nExit code: `0`',
              },
              { type: 'response.completed' },
            ];
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          'content-type': 'text/event-stream; charset=utf-8',
        },
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
      Object.defineProperty(globalThis, 'confirm', {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(globalThis, 'showDirectoryPicker', {
        configurable: true,
        value: async (options?: { readonly mode?: string }) => {
          const pickerState = globalThis as typeof globalThis & { __loomPickerMode?: string };
          if (options?.mode === undefined) delete pickerState.__loomPickerMode;
          else pickerState.__loomPickerMode = options.mode;
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
    await expect(application.locator('#access-summary')).toHaveText('Read and write enabled');
    await application.getByLabel('Experimental extension ID').fill(extensionId);
    await application.getByRole('button', { name: 'Reconnect' }).click();
    await expect(application.getByRole('status')).toHaveText(/Approve this exact website origin/u);
    await expect(options.locator('#pending-origins')).toContainText(browserOrigin);
    await options.getByRole('button', { name: 'Approve' }).click();
    await expect(options.locator('#approved-origins')).toContainText(browserOrigin);
    await application.bringToFront();
    await application.reload();
    await expect(application.getByRole('status')).toHaveText(/^Authenticated\./u);
    await application.getByRole('button', { name: 'Choose directory and send' }).click();
    expect(
      await application.evaluate(
        () => (globalThis as typeof globalThis & { __loomPickerMode?: string }).__loomPickerMode,
      ),
    ).toBe('readwrite');
    await expect(application.getByRole('status')).toHaveText('Run complete.');
    const experimentLog = application.getByRole('log', {
      name: 'Coding conversation',
    });
    await expect(experimentLog).toContainText('Explore the project root');
    await expect(experimentLog.locator('.tool-state').first()).toHaveText('Done');
    await expect(experimentLog).toContainText('The selected workspace contains source.txt.');
    await expect(experimentLog.locator('.markdown-code-header')).toHaveText(/OutputCopy/u);
    await expect(experimentLog.locator('.markdown-code pre')).toContainText(
      'Original array: [1 2 3 4 5]',
    );
    await expect(experimentLog.locator('.chat-message.assistant p code')).toHaveText('0');
    await expect(application.locator('#transport-status')).toHaveText('Extension relay');
    await expect(experimentLog).not.toContainText('Retrying through the extension');

    expect(directFailures).toBe(1);
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.headers.authorization).toBe('Bearer vertical-refreshed-access');
    expect(modelRequests[0]?.headers['chatgpt-account-id']).toBe('vertical-account');
    expect(modelRequests[0]?.headers.originator).toBe('loom_extension_experiment');
    expect(modelRequests[0]?.frameUrl).toBe('extension-service-worker');
    expect(modelRequests[1]?.headers.originator).toBe('loom_extension_experiment');
    expect(modelRequests[1]?.frameUrl).toBe('extension-service-worker');
    const firstRequestBody = JSON.parse(modelRequests[0]?.body ?? '{}') as {
      readonly input?: readonly unknown[];
    };
    expect(firstRequestBody).toMatchObject({
      parallel_tool_calls: false,
      reasoning: { effort: 'medium', context: 'all_turns' },
    });
    expect(firstRequestBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'additional_tools',
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'loom_8_website_run-workspace-file',
              description: expect.stringContaining('real exit code, stdout, and stderr'),
              parameters: expect.objectContaining({
                required: ['runtime', 'path'],
              }),
            }),
            expect.objectContaining({
              name: 'loom_9_website_install-runtime-packages',
              description: expect.stringContaining('Additional Python packages use micropip'),
              parameters: expect.objectContaining({
                required: ['runtime', 'packages'],
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(modelRequests[1]?.body).toContain('function_call_output');
    expect(modelRequests[1]?.body).toContain('source.txt');
    expect(await application.locator('body').innerText()).not.toMatch(
      /vertical-(?:refresh|initial|refreshed)-/u,
    );

    await application.reload();
    await expect(application.getByRole('status')).toHaveText(/^Authenticated\./u);
    await expect(application.locator('#transport-status')).toHaveText('Extension relay');
    await application.getByLabel('Message').fill('Check the workspace once more.');
    await application.getByRole('button', { name: 'Choose directory and send' }).click();
    await expect(application.locator('#activity-status')).toHaveAttribute('data-state', 'working');
    await expect(application.getByRole('status')).toHaveText('Run complete.');
    await expect(application.locator('#activity-status')).toHaveText('Ready');
    await expect(application.getByRole('log', { name: 'Coding conversation' })).toContainText(
      'The selected workspace contains source.txt.',
    );
    await expect(application.locator('#conversation-list button')).toHaveCount(1);
    expect(modelRequests).toHaveLength(3);
    expect(modelRequests[2]?.frameUrl).toBe('extension-service-worker');
    expect(
      modelRequests.filter((request) => request.frameUrl === 'extension-service-worker'),
    ).toHaveLength(3);
    const scrollMetrics = await experimentLog.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await expect(application.getByLabel('Message')).toBeVisible();
    await application.getByLabel('Message').fill('The next command remains reachable.');
    await expect(application.getByLabel('Message')).toHaveValue(
      'The next command remains reachable.',
    );

    await application.getByRole('button', { name: 'New', exact: true }).click();
    await expect(application.locator('#conversation-list button')).toHaveCount(2);
    await expect(application.getByRole('status')).toHaveText(
      'New conversation created in .loom/conversations.',
    );
    await application.locator('#conversation-list button').last().click();
    await expect(experimentLog).toContainText('The selected workspace contains source.txt.');
    await application.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(application.locator('#conversation-list button')).toHaveCount(1);
    await application.getByRole('button', { name: 'Clean .loom', exact: true }).click();
    await expect(application.locator('#conversation-list')).toHaveText('No saved conversations.');
    await expect(application.getByRole('status')).toHaveText(
      '.loom was removed from the workspace.',
    );

    await application.locator('#allow-write').uncheck();
    await expect(application.locator('#access-summary')).toHaveText(
      'Read-only; runtime changes are discarded',
    );
    await expect(application.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
    await expect(application.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(
      application.getByRole('button', { name: 'Clean .loom', exact: true }),
    ).toBeDisabled();
    await expect(application.getByRole('status')).toHaveText(
      'Workspace access changed. Reopen the local folder to apply it.',
    );
    await application.getByRole('button', { name: 'Open' }).click();
    expect(
      await application.evaluate(
        () => (globalThis as typeof globalThis & { __loomPickerMode?: string }).__loomPickerMode,
      ),
    ).toBe('read');
    await expect(application.locator('#save-file')).toBeDisabled();

    await application.getByRole('button', { name: 'Log out' }).click();
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
