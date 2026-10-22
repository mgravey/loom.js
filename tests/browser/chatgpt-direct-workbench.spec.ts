import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'tsup';

import { browserOrigin, openBuiltEsmHarness, workspaceRoot } from './built-esm-harness.js';

// Exercise the real workbench against the auth contract, without provider requests,
// credentials, popups, or a test-only authentication hook in production code.
const clientFixture = `
import { OpenAIResponsesModelError } from '@mgravey/loom-model-openai-responses';
export class ChatGPTDirectError extends OpenAIResponsesModelError {
  constructor(message) { super('PROVIDER_ERROR', message); }
}
export function createChatGPTDirectClient() {
  const calls = { signIns: [], discoveries: 0, generations: 0, gesture: false };
  globalThis.chatgptFixtureCalls = calls;
  const accounts = location.search.includes('empty-accounts') ? [] :
    [{ id: 'registration-a', label: 'Saved account (oaiapp_fixture_registration)' }];
  const status = { supported: !location.search.includes('unsupported'), authenticated: false,
    planEnabled: false, accounts, notice: location.search.includes('actionable-notice')
      ? 'Saved accounts could not be loaded.' : 'Local browser sign-in is experimental.' };
  let complete;
  let reject;
  globalThis.finishChatGPTFixture = (planEnabled = true) => complete?.(planEnabled);
  return {
    getStatus: () => ({ ...status }),
    signIn(accountId) {
      calls.gesture = navigator.userActivation.isActive;
      calls.signIns.push(accountId ?? 'new');
      if (location.search.includes('popup-blocked'))
        return Promise.reject(new ChatGPTDirectError('Allow popups for this site, then continue with ChatGPT.'));
      return new Promise((resolve, rejectSignIn) => {
        reject = rejectSignIn;
        complete = (planEnabled) => {
          status.authenticated = true;
          status.planEnabled = planEnabled;
          status.activeAccountId = accountId ?? 'registration-b';
          status.accountLabel = accountId ? 'Saved account' : '<img src=x onerror=alert(1)>';
          if (!accounts.some(a => a.id === status.activeAccountId))
            accounts.push({ id: status.activeAccountId, label: status.accountLabel });
          resolve();
        };
      });
    },
    cancelSignIn() { reject?.(new Error('Cancelled')); reject = undefined; complete = undefined; },
    async signOut() { status.authenticated = false; status.planEnabled = false; return { revoked: false }; },
    async listModels() { calls.discoveries++; return [
      { slug: 'same-model', displayName: 'Fixture model' },
      { slug: 'other-model', displayName: 'Other fixture model' }
    ]; },
    transport: { async send(request) {
      calls.generations++;
      if (!location.search.includes('generation-fixture')) throw new Error('No model calls permitted');
      globalThis.chatgptFixtureRequest = JSON.parse(request.body);
      await new Promise((resolve, reject) => {
        globalThis.finishGenerationFixture = resolve;
        request.signal?.onCancel(() => reject(new Error('Cancelled fixture')));
      });
      return { status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'fixture-response', status: 'completed',
        output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic browser response.' }] }]
      }) };
    } },
    dispose() {},
  };
}
`;
let temporaryDirectory: string;
let workbenchBundle: string;

test.beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'loom-chatgpt-ui-'));
  await build({
    config: false,
    entry: [join(workspaceRoot, 'packages/example-codex-experimental/src/main.ts')],
    outDir: temporaryDirectory,
    tsconfig: join(workspaceRoot, 'packages/example-codex-experimental/tsconfig.build.json'),
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    silent: true,
    noExternal: [/^@mgravey\/loom-/],
    esbuildPlugins: [
      {
        name: 'browser-auth-contract-fixture',
        setup(builder) {
          builder.onResolve({ filter: /\/chatgpt-direct\.js$/ }, () => ({
            path: 'auth-fixture',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: clientFixture,
            loader: 'js',
            resolveDir: join(workspaceRoot, 'packages/example-codex-experimental/src'),
          }));
        },
      },
    ],
  });
  workbenchBundle = await readFile(join(temporaryDirectory, 'main.js'), 'utf8');
});

test.afterAll(async () => {
  if (temporaryDirectory !== undefined)
    await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openWorkbench(page: Page, query = ''): Promise<void> {
  await page.addInitScript(() => {
    const host = globalThis as typeof globalThis & { extensionCalls: number };
    host.extensionCalls = 0;
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          connect() {
            host.extensionCalls++;
            throw new Error('Unexpected extension call');
          },
          sendMessage() {
            host.extensionCalls++;
            throw new Error('Unexpected extension call');
          },
        },
      },
    });
  });
  await openBuiltEsmHarness(page);
  await page.route('**/example-codex-experimental/dist/main.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: workbenchBundle,
    }),
  );
  await page.goto(`${browserOrigin}/example-codex-experimental/workbench.html${query}`);
}
async function finishLogin(page: Page, planEnabled = true): Promise<void> {
  await page.evaluate((enabled) => {
    (
      globalThis as typeof globalThis & { finishChatGPTFixture: (enabled: boolean) => void }
    ).finishChatGPTFixture(enabled);
  }, planEnabled);
}
async function calls(page: Page) {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          chatgptFixtureCalls: {
            signIns: string[];
            discoveries: number;
            generations: number;
            gesture: boolean;
          };
        }
      ).chatgptFixtureCalls,
  );
}

test('browser account login stays in direct mode, requires consent, and never invokes a model automatically', async ({
  page,
}) => {
  await openWorkbench(page);
  await expect(page.locator('#model-provider')).toHaveCount(0);
  await expect(page.locator('#extension-id-settings')).toHaveCount(0);
  await expect(page.locator('#codex-connection-settings')).toHaveCount(0);
  await expect(page.locator('#local-model-connection-settings')).toHaveCount(0);
  await expect(page.locator('#chatgpt-direct-settings')).toBeVisible();
  await expect(page.locator('#chatgpt-sign-out')).toBeHidden();
  await expect(page.locator('#chatgpt-account')).not.toContainText('oaiapp');
  await expect(page.locator('#run')).toBeDisabled();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.locator('#model')).toBeDisabled();
  await expect(page.locator('#chatgpt-account')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
  await finishLogin(page);
  await expect(page.locator('#chatgpt-status')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#chatgpt-status img')).toHaveCount(0);
  await expect(page.locator('#chatgpt-plan-confirmation')).toBeVisible();
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#available-models').selectOption('chatgpt-direct:other-model');
  await expect(page.locator('#model-provider')).toHaveCount(0);
  await expect(page.locator('#model')).toHaveValue('other-model');
  expect(await calls(page)).toEqual({
    signIns: ['new'],
    discoveries: 1,
    generations: 0,
    gesture: true,
  });
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { extensionCalls: number }).extensionCalls,
    ),
  ).toBe(0);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#chatgpt-status')).toContainText(
    'Provider revocation could not be confirmed',
  );
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await finishLogin(page);
  await expect(page.locator('#chatgpt-sign-in')).toBeEnabled();
  await expect(page.locator('#chatgpt-plan-confirmation')).toBeHidden();
  await expect(page.locator('#run')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#chatgpt-plan-confirmation')).toBeHidden();
});

test('saved account login, cancelled login and missing plan consent leave generation disabled', async ({
  page,
}) => {
  await openWorkbench(page);
  await page.locator('#chatgpt-account').selectOption('registration-a');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.locator('#chatgpt-status')).toHaveText('ChatGPT login cancelled.');
  await expect(page.locator('#chatgpt-sign-in')).toBeEnabled();
  await expect(page.locator('#run')).toBeDisabled();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await finishLogin(page, false);
  await expect(page.locator('#chatgpt-status')).toContainText('plan is not enabled');
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#chatgpt-plan-confirmation')).toBeHidden();
  expect(await calls(page)).toMatchObject({
    signIns: ['registration-a', 'registration-a'],
    discoveries: 0,
    generations: 0,
  });
});

for (const legacyProvider of [
  undefined,
  'codex-experimental',
  'openai-compatible-responses',
  'unknown',
]) {
  test(`always uses ChatGPT with legacy query/storage provider ${legacyProvider ?? 'absent'}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('loom.model-provider', 'openai-compatible-responses');
      localStorage.setItem('loom.chrome-extension-id', 'a'.repeat(32));
      localStorage.setItem('loom.local-model.model', 'legacy-server-only');
      localStorage.setItem('loom.local-model.connection-id', 'old-server');
      localStorage.setItem('loom.local-model.api-key', 'obsolete-fixture-key');
      sessionStorage.setItem('loom.codex-model-transport.' + 'a'.repeat(32), 'relay');
    });
    await openWorkbench(
      page,
      legacyProvider === undefined
        ? ''
        : `?provider=${legacyProvider}&extensionId=${'b'.repeat(32)}`,
    );
    await expect(
      page.locator('#model-provider, #extension-id, #connect-local-model, #check-auth, #logout'),
    ).toHaveCount(0);
    await expect(page.locator('#chatgpt-direct-settings')).toBeVisible();
    await expect(page.locator('#model')).toHaveValue('');
    await expect(page.locator('#transport-status')).toHaveAttribute('data-mode', 'direct');
    expect(await page.evaluate(() => localStorage.getItem('loom.local-model.api-key'))).toBeNull();
    await expect(page.locator('#chatgpt-sign-out')).toBeHidden();
    await expect(page.locator('#run')).toBeDisabled();
    expect(await calls(page)).toMatchObject({ signIns: [], discoveries: 0, generations: 0 });
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { extensionCalls: number }).extensionCalls,
      ),
    ).toBe(0);
    await page.locator('#chatgpt-sign-in').click();
    await finishLogin(page);
    await expect(page.locator('#available-models')).toHaveValue('chatgpt-direct:same-model');
    await expect(page.locator('#run')).toBeEnabled();
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { extensionCalls: number }).extensionCalls,
      ),
    ).toBe(0);
  });
}

test('shows account selection only after an account is saved', async ({ page }) => {
  await openWorkbench(page, '?empty-accounts');
  await expect(page.locator('#chatgpt-account')).toBeHidden();
  await expect(page.locator('#chatgpt-sign-out')).toBeHidden();
  await page.locator('#chatgpt-sign-in').click();
  await finishLogin(page);
  await expect(page.locator('#chatgpt-account')).toBeVisible();
  await expect(page.locator('#chatgpt-sign-out')).toBeVisible();
  await page.locator('#chatgpt-sign-out').click();
  await expect(page.locator('#chatgpt-sign-out')).toBeHidden();
  await expect(page.locator('#chatgpt-account')).toBeVisible();
});

test('unsupported browser origin directs the user to the local test and cannot claim authentication', async ({
  page,
}) => {
  await openWorkbench(page, '?provider=chatgpt-direct&unsupported');
  await expect(page.locator('#chatgpt-sign-in')).toBeDisabled();
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#chatgpt-local-only')).toBeVisible();
  await expect(page.getByRole('link', { name: 'local workbench' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:4174/example-codex-experimental/workbench.html',
  );
  await expect(page.locator('#chatgpt-status')).toContainText(
    'Sign-in is unavailable on this origin.',
  );
  expect(await calls(page)).toMatchObject({ signIns: [], discoveries: 0, generations: 0 });
});

test('production bundle exposes the local-only account panel on an unsupported origin', async ({
  page,
}) => {
  await openBuiltEsmHarness(page);
  await page.goto(
    `${browserOrigin}/example-codex-experimental/workbench.html?provider=chatgpt-direct`,
  );
  await expect(page.locator('#chatgpt-direct-settings')).toBeVisible();
  await expect(page.locator('#chatgpt-sign-in')).toBeDisabled();
  await expect(page.locator('#chatgpt-local-only')).toBeVisible();
  await expect(page.locator('#extension-id-settings')).toHaveCount(0);
  await expect(page.locator('#run')).toBeDisabled();
});

test('explicit synthetic generation uses the browser transport and locks connection controls', async ({
  page,
}) => {
  await openWorkbench(page, '?provider=chatgpt-direct&generation-fixture');
  await page.locator('#chatgpt-sign-in').click();
  await finishLogin(page);
  await page.locator('#workspace-mode').selectOption('memory');
  await page.locator('#thinking-level').selectOption('high');
  await page.locator('#prompt').fill('Synthetic fixture request');
  await page.locator('#run').click();
  await expect.poll(async () => (await calls(page)).generations).toBe(1);
  await expect(page.locator('#chatgpt-sign-out')).toBeDisabled();
  await expect(page.locator('#chatgpt-account')).toBeDisabled();
  await expect(page.locator('#available-models')).toBeDisabled();
  await expect(page.locator('#run')).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            chatgptFixtureRequest: unknown;
          }
        ).chatgptFixtureRequest,
    ),
  ).toMatchObject({ model: 'same-model', reasoning: { effort: 'high' } });
  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        finishGenerationFixture: () => void;
      }
    ).finishGenerationFixture(),
  );
  await expect(page.locator('#status')).toHaveText('Run complete.');
  await expect(page.locator('#log')).toContainText('Synthetic browser response.');
  await expect(page.locator('#chatgpt-sign-out')).toBeEnabled();
  await expect(page.locator('#model-provider')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            extensionCalls: number;
          }
        ).extensionCalls,
    ),
  ).toBe(0);
});

test('preserves actionable safe authentication errors', async ({ page }) => {
  await openWorkbench(page, '?provider=chatgpt-direct&popup-blocked');
  await page.locator('#chatgpt-sign-in').click();
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#chatgpt-status')).toBeHidden();
  await expect(page.locator('#chatgpt-error')).toHaveText(
    'ChatGPT sign-in failed: Allow popups for this site, then continue with ChatGPT.',
  );
  await expect(page.locator('#chatgpt-error')).toBeInViewport();
  await expect(page.locator('#chatgpt-sign-in')).toBeEnabled();
  await expect(page.locator('#run')).toBeDisabled();
});

async function installWorkspacePicker(page: Page, legacy = false): Promise<void> {
  await page.addInitScript((withLegacy) => {
    const host = globalThis as typeof globalThis & { pickerMode?: string };
    Object.defineProperty(globalThis, 'showDirectoryPicker', {
      configurable: true,
      value: async (options: { mode?: string }) => {
        host.pickerMode = options.mode ?? '';
        const root = await navigator.storage.getDirectory();
        const workspace = await root.getDirectoryHandle('chatgpt-workbench-fixture', {
          create: true,
        });
        const source = await workspace.getFileHandle('source.txt', { create: true });
        if ((await source.getFile()).size === 0) {
          const writer = await source.createWritable();
          await writer.write('Original workspace text');
          await writer.close();
        }
        if (withLegacy) {
          const loom = await workspace.getDirectoryHandle('.loom', { create: true });
          const conversations = await loom.getDirectoryHandle('conversations', { create: true });
          const file = await conversations.getFileHandle('conversation-legacy.json', {
            create: true,
          });
          if ((await file.getFile()).size === 0) {
            const writer = await file.createWritable();
            await writer.write(
              JSON.stringify({
                version: 3,
                id: 'conversation-legacy',
                title: 'Legacy server history',
                modelProvider: 'openai-compatible-responses',
                model: 'server-only-model',
                connectionId: 'legacy-server',
                createdAt: 1,
                updatedAt: 2,
                transcript: [
                  { role: 'user', content: 'Keep the earlier request' },
                  { role: 'assistant', content: 'Keep the earlier answer' },
                ],
              }),
            );
            await writer.close();
          }
        }
        return workspace;
      },
    });
  }, legacy);
}

test('edits files and manages conversations before sign-in while enforcing read-only access', async ({
  page,
}) => {
  await installWorkspacePicker(page);
  await openWorkbench(page, '?empty-accounts');
  page.on('dialog', (dialog) => void dialog.accept());
  await page.locator('#open-workspace').click();
  await expect(page.locator('#file-list')).toContainText('source.txt');
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { pickerMode?: string }).pickerMode,
    ),
  ).toBe('readwrite');
  await page.locator('#new-conversation').click();
  await expect(page.locator('#conversation-list button')).toHaveCount(1);
  await expect(page.locator('#model')).toHaveValue('');
  await page.locator('#file-list button').filter({ hasText: 'source.txt' }).click();
  await expect(page.locator('#editor')).toHaveValue('Original workspace text');
  await page.locator('#editor').fill('Saved workspace text');
  await page.locator('#save-file').click();
  await expect(page.locator('#status')).toHaveText('source.txt saved.');
  await page.locator('#open-workspace').click();
  await page.locator('#file-list button').filter({ hasText: 'source.txt' }).click();
  await expect(page.locator('#editor')).toHaveValue('Saved workspace text');
  await expect(page.locator('#conversation-list button')).toHaveCount(1);
  await page.locator('.workspace-access > summary').click();
  await page.locator('#allow-write').uncheck();
  await page.locator('#open-workspace').click();
  await page.locator('#file-list button').filter({ hasText: 'source.txt' }).click();
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { pickerMode?: string }).pickerMode,
    ),
  ).toBe('read');
  for (const selector of ['#save-file', '#new-conversation', '#delete-conversation', '#clean-loom'])
    await expect(page.locator(selector)).toBeDisabled();
  await page.locator('#allow-write').check();
  await page.locator('#open-workspace').click();
  await page.locator('#delete-conversation').click();
  await expect(page.locator('#conversation-list button')).toHaveCount(0);
  await page.locator('#new-conversation').click();
  await expect(page.locator('#conversation-list button')).toHaveCount(1);
  await page.locator('#clean-loom').click();
  await expect(page.locator('#conversation-list button')).toHaveCount(0);
  await expect(page.locator('#file-list')).toContainText('source.txt');
  await expect(page.locator('#run')).toBeDisabled();
  expect(await calls(page)).toMatchObject({ signIns: [], discoveries: 0, generations: 0 });
});

test('reopens legacy server history and continues it only through browser ChatGPT', async ({
  page,
}) => {
  await installWorkspacePicker(page, true);
  await openWorkbench(page, '?provider=openai-compatible-responses&generation-fixture');
  await page.locator('#open-workspace').click();
  await expect(page.locator('#conversation-list')).toContainText('Legacy server history');
  await expect(page.locator('#log')).toContainText('Keep the earlier answer');
  await expect(page.locator('#model')).toHaveValue('');
  await expect(page.locator('#run')).toBeDisabled();
  await page.locator('#chatgpt-sign-in').click();
  await finishLogin(page);
  await expect(page.locator('#model')).toHaveValue('same-model');
  await page.locator('#prompt').fill('Continue the earlier request');
  await page.locator('#run').click();
  await expect.poll(async () => (await calls(page)).generations).toBe(1);
  const request = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { chatgptFixtureRequest: unknown }).chatgptFixtureRequest,
  );
  expect(request).toMatchObject({ model: 'same-model' });
  expect(JSON.stringify(request)).toContain('Keep the earlier request');
  expect(JSON.stringify(request)).not.toContain('server-only-model');
  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & { finishGenerationFixture: () => void }
    ).finishGenerationFixture(),
  );
  await expect(page.locator('#status')).toHaveText('Run complete.');
  await page.locator('#open-workspace').click();
  await expect(page.locator('#log')).toContainText('Synthetic browser response.');
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle('chatgpt-workbench-fixture');
    const loom = await workspace.getDirectoryHandle('.loom');
    const conversations = await loom.getDirectoryHandle('conversations');
    const handle = await conversations.getFileHandle('conversation-legacy.json');
    return JSON.parse(await (await handle.getFile()).text()) as Record<string, unknown>;
  });
  expect(saved).toMatchObject({ modelProvider: 'chatgpt-direct', model: 'same-model' });
  expect(saved).not.toHaveProperty('connectionId');
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { extensionCalls: number }).extensionCalls,
    ),
  ).toBe(0);
});

test('keeps the signed-out status concise and preserves actionable notices', async ({ page }) => {
  await openWorkbench(page);
  await expect(page.locator('#chatgpt-status')).toHaveText('Use your ChatGPT account and plan.');
  await page.goto(`${browserOrigin}/example-codex-experimental/workbench.html?actionable-notice`);
  await expect(page.locator('#chatgpt-status')).toContainText(
    'Saved accounts could not be loaded.',
  );
});
