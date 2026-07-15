import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { openBuiltEsmHarness, workspaceRoot } from './built-esm-harness.js';

const extensionPath = join(workspaceRoot, 'packages', 'extension-codex-experimental', 'dist');
const providerId = 'openai/codex-experimental';
const refreshKey = `loom.refresh-credential.${encodeURIComponent(providerId)}`;

interface ExternalResponse {
  readonly ok?: boolean;
  readonly accessToken?: string;
  readonly error?: { readonly code?: string };
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

async function sendExternalMessage(page: Page, extensionId: string): Promise<ExternalResponse> {
  return page.evaluate(
    async ({ id, selectedProvider }) => {
      const runtime = (
        globalThis as typeof globalThis & {
          readonly chrome?: {
            readonly runtime?: {
              readonly lastError?: { readonly message?: string };
              sendMessage(
                extensionId: string,
                message: unknown,
                options: undefined,
                callback: (response: unknown) => void,
              ): void;
            };
          };
        }
      ).chrome?.runtime;
      if (runtime === undefined) throw new Error('External extension messaging is unavailable.');
      return new Promise<ExternalResponse>((resolve, reject) => {
        runtime.sendMessage(
          id,
          {
            protocol: 'loom/credential-broker',
            version: 1,
            type: 'getAccessToken',
            requestId: 'phase-five-browser',
            providerId: selectedProvider,
          },
          undefined,
          (response) => {
            if (runtime.lastError !== undefined) {
              reject(new Error(runtime.lastError.message ?? 'Extension messaging failed.'));
              return;
            }
            resolve(response as ExternalResponse);
          },
        );
      });
    },
    { id: extensionId, selectedProvider: providerId },
  );
}

test.describe('experimental Codex credential extension', () => {
  test.describe.configure({ mode: 'serial' });

  test('is disabled by default and cannot silently authorize from a Loom page', async () => {
    const { context, extensionId } = await launchExtension();
    try {
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(
        options.getByLabel(/enable the experimental device-code flow/i),
      ).not.toBeChecked();
      await expect(
        options.getByRole('button', { name: 'Start device authorization' }),
      ).toBeDisabled();
      await expect(options.getByRole('status')).toHaveText('The experiment is disabled.');

      const application = await context.newPage();
      await openBuiltEsmHarness(application);
      const response = await sendExternalMessage(application, extensionId);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'AUTHENTICATION_REQUIRED' },
      });
      expect(JSON.stringify(response)).not.toMatch(/refresh|verifier|authorization.code/iu);
    } finally {
      await context.close();
    }
  });

  test('completes the manual device experiment against a fully local network fixture', async () => {
    const verifier = Buffer.alloc(64, 7).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const requests: { readonly path: string; readonly body: string }[] = [];
    const { context, extensionId } = await launchExtension();
    try {
      await context.route('https://auth.openai.com/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const body = request.postData() ?? '';
        requests.push({ path: url.pathname, body });
        const headers = {
          'access-control-allow-origin': '*',
          'content-type': 'application/json; charset=utf-8',
        };
        if (url.pathname === '/api/accounts/deviceauth/usercode') {
          await route.fulfill({
            status: 200,
            headers,
            body: JSON.stringify({
              device_auth_id: 'local-device-id',
              user_code: 'LOOM-CODE',
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
              authorization_code: 'local-one-time-code',
              code_verifier: verifier,
              code_challenge: challenge,
            }),
          });
          return;
        }
        if (url.pathname === '/oauth/token') {
          await route.fulfill({
            status: 200,
            headers,
            body: JSON.stringify({
              id_token: 'local-id-token',
              access_token: 'local-access-token',
              refresh_token: 'local-refresh-token',
              expires_in: 60,
            }),
          });
          return;
        }
        await route.abort('blockedbyclient');
      });

      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.getByLabel(/enable the experimental device-code flow/i).check();
      await options.getByRole('button', { name: 'Start device authorization' }).click();
      await expect(options.getByRole('status')).toHaveText(/Authorization complete/);

      const stored = await options.evaluate(async (key) => {
        const storage = (
          globalThis as typeof globalThis & {
            readonly chrome: {
              readonly storage: {
                readonly local: { get(key: string): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome.storage.local;
        return storage.get(key);
      }, refreshKey);
      expect(stored).toEqual({ [refreshKey]: 'local-refresh-token' });
      expect(await options.locator('body').innerText()).not.toMatch(
        /local-(?:refresh|access|id)-token|local-one-time-code|code.verifier/iu,
      );
      expect(requests.map((request) => request.path)).toEqual([
        '/api/accounts/deviceauth/usercode',
        '/api/accounts/deviceauth/token',
        '/oauth/token',
      ]);
      expect(requests[2]?.body).toContain(
        'redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback',
      );
      expect(requests[2]?.body).not.toContain('client_secret');
    } finally {
      await context.close();
    }
  });
});
