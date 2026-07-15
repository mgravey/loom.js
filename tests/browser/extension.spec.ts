import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { join } from 'node:path';

import { browserOrigin, openBuiltEsmHarness, workspaceRoot } from './built-esm-harness.js';

const extensionPath = join(workspaceRoot, 'packages', 'extension', 'dist');
const mockCredentialKey = 'loom.refresh-credential.loom%2Fmock';

interface ExternalResponse {
  readonly ok?: boolean;
  readonly accessToken?: string;
  readonly error?: {
    readonly code?: string;
  };
}

function request(requestId: string, providerId = 'loom/mock'): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: 'loom/credential-broker',
    version: 1,
    type: 'getAccessToken',
    requestId,
    providerId,
  });
}

async function sendExternalMessage(
  page: Page,
  extensionId: string,
  message: Readonly<Record<string, unknown>>,
): Promise<ExternalResponse> {
  return page.evaluate(
    async ({ id, payload }) => {
      const host = globalThis as typeof globalThis & {
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
      };
      const runtime = host.chrome?.runtime;
      if (runtime === undefined) throw new Error('External extension messaging is unavailable.');
      return new Promise<ExternalResponse>((resolve, reject) => {
        runtime.sendMessage(id, payload, undefined, (response) => {
          const lastError = runtime.lastError;
          if (lastError !== undefined) {
            reject(new Error(lastError.message ?? 'External extension messaging failed.'));
            return;
          }
          resolve(response as ExternalResponse);
        });
      });
    },
    { id: extensionId, payload: message },
  );
}

async function launchExtension(): Promise<{
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly worker: Worker;
}> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).hostname;
  return { context, extensionId, worker };
}

test.describe('Manifest V3 credential broker', () => {
  test.describe.configure({ mode: 'serial' });

  test('composes the real extension with Loom AuthProvider from an allowed page', async () => {
    const { context, extensionId } = await launchExtension();
    try {
      const page = await context.newPage();
      await openBuiltEsmHarness(page);
      await page.goto(`${browserOrigin}/example-extension/index.html`);
      await page.getByLabel('Extension ID').fill(extensionId);
      await page.getByRole('button', { name: 'Request access token' }).click();

      await expect(page.getByRole('status')).toHaveText(
        'Token received through Loom AuthProvider.',
      );
      await expect(page.getByLabel('Credential broker result')).toHaveText('mock-access-token-1');
    } finally {
      await context.close();
    }
  });

  test('deduplicates concurrent refreshes and rejects unknown providers', async () => {
    const { context, extensionId } = await launchExtension();
    try {
      const page = await context.newPage();
      await openBuiltEsmHarness(page);

      const [first, second] = await Promise.all([
        sendExternalMessage(page, extensionId, request('concurrent-1')),
        sendExternalMessage(page, extensionId, request('concurrent-2')),
      ]);
      expect(first).toMatchObject({ ok: true, accessToken: 'mock-access-token-1' });
      expect(second).toMatchObject({ ok: true, accessToken: 'mock-access-token-1' });

      const unknown = await sendExternalMessage(
        page,
        extensionId,
        request('unknown-provider', 'loom/unknown'),
      );
      expect(unknown).toMatchObject({ ok: false, error: { code: 'PROVIDER_NOT_FOUND' } });
    } finally {
      await context.close();
    }
  });

  test('does not serve a page outside the exact origin allowlist', async () => {
    const { context, extensionId } = await launchExtension();
    try {
      await context.route('http://localhost:4174/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><meta charset="utf-8"><title>Unauthorized origin</title>',
        });
      });
      const page = await context.newPage();
      await page.goto('http://localhost:4174/');

      const response = await sendExternalMessage(page, extensionId, request('unauthorized-origin'));
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED_REQUEST' },
      });
    } finally {
      await context.close();
    }
  });

  test('reports authentication required without exposing refresh state', async () => {
    const { context, extensionId, worker } = await launchExtension();
    try {
      await expect
        .poll(() =>
          worker.evaluate(async (key) => {
            const storage = (
              globalThis as typeof globalThis & {
                readonly chrome: {
                  readonly storage: {
                    readonly local: {
                      get(key: string): Promise<Record<string, unknown>>;
                    };
                  };
                };
              }
            ).chrome.storage.local;
            return typeof (await storage.get(key))[key] === 'string';
          }, mockCredentialKey),
        )
        .toBe(true);
      await worker.evaluate(async (key) => {
        const storage = (
          globalThis as typeof globalThis & {
            readonly chrome: {
              readonly storage: {
                readonly local: {
                  remove(key: string): Promise<void>;
                };
              };
            };
          }
        ).chrome.storage.local;
        await storage.remove(key);
      }, mockCredentialKey);

      const page = await context.newPage();
      await openBuiltEsmHarness(page);
      const response = await sendExternalMessage(page, extensionId, request('missing-credential'));
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'AUTHENTICATION_REQUIRED' },
      });
      expect(JSON.stringify(response)).not.toContain('development-only-mock-credential');
    } finally {
      await context.close();
    }
  });
});
