import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

test('connects directly to an OpenAI-compatible Responses server with tools and JSON fallback', async ({
  page,
}) => {
  const requests: { readonly headers: Readonly<Record<string, string>>; readonly body: string }[] =
    [];

  await page.route('http://localhost:11434/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const corsHeaders = {
      'access-control-allow-origin': browserOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'accept, authorization, content-type',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (url.pathname === '/v1/models') {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'gpt-oss:20b' }] }),
      });
      return;
    }
    if (url.pathname !== '/v1/responses') {
      await route.fulfill({ status: 404, headers: corsHeaders });
      return;
    }
    requests.push({ headers: request.headers(), body: request.postData() ?? '' });
    const turn = requests.length;
    if (turn === 1) {
      const events = [
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
      ];
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'text/event-stream; charset=utf-8' },
        body: `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
      });
      return;
    }
    if (turn === 2) {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'text/event-stream; charset=utf-8' },
        body:
          'data: {"type":"response.output_text.delta","delta":"The local workspace is ready."}\n\n' +
          'data: {"type":"response.completed"}\n\n' +
          'data: [DONE]\n\n',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Complete JSON fallback works.' }],
          },
        ],
      }),
    });
  });

  await openBuiltEsmHarness(page);
  await page.goto(`${browserOrigin}/example-codex-experimental/workbench.html`);
  await page.getByLabel('Model connection').selectOption('openai-compatible-responses');
  await page.getByLabel('API key').fill('local-browser-secret');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByRole('status')).toHaveText('OpenAI-compatible model server connected.');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('qwen3:8b');
  await expect(page.locator('#transport-status')).toHaveText('Direct model server');
  await expect(page.getByLabel('Available models').locator('option')).toHaveText([
    'Select a model',
    'qwen3:8b',
    'gpt-oss:20b',
  ]);
  await page.getByLabel('Available models').selectOption('gpt-oss:20b');
  await page.getByLabel('Thinking level').selectOption('high');
  await page.locator('#workspace-mode').selectOption('memory');
  await page.getByLabel('Message').fill('Inspect this local workspace.');
  await page.getByRole('button', { name: 'Choose directory and send' }).click();

  await expect(page.getByRole('status')).toHaveText('Run complete.');
  const log = page.getByRole('log', { name: 'Coding conversation' });
  await expect(log).toContainText('Explore the project root');
  await expect(log).toContainText('The local workspace is ready.');
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
    model: 'gpt-oss:20b',
    reasoning: { effort: 'high' },
  });
  expect(requests[0]?.headers.authorization).toBe('Bearer local-browser-secret');
  expect(requests[0]?.body).not.toContain('allowed_callers');
  expect(requests[0]?.body).not.toContain('programmatic_tool_calling');
  expect(requests[1]?.body).toContain('function_call_output');

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Message').fill('Use the complete response path.');
  await page.getByRole('button', { name: 'Send coding request' }).click();
  await expect(page.getByRole('status')).toHaveText('Run complete.');
  await expect(log).toContainText('Complete JSON fallback works.');
  expect(requests).toHaveLength(3);

  await page.reload();
  await expect(page.getByLabel('Thinking level')).toHaveValue('high');
  await expect(page.getByLabel('Model connection')).toHaveValue('openai-compatible-responses');
  await expect(page.getByLabel('API key')).toHaveValue('local-browser-secret');
  await expect(page.locator('#run')).toBeDisabled();
  await page.getByRole('button', { name: 'Clear API key' }).click();
  await expect(page.getByLabel('API key')).toHaveValue('');
  expect(
    await page.evaluate(() => globalThis.localStorage.getItem('loom.local-model.api-key')),
  ).toBeNull();
});

test('refreshes the experimental Codex catalogue and keeps manual entry after failure', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('loom.chrome-extension-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          connect() {
            throw new Error('Unused in catalogue discovery');
          },
          sendMessage(
            _id: string,
            message: Record<string, unknown>,
            _options: unknown,
            callback: (value: unknown) => void,
          ) {
            callback({
              ...message,
              type: `${String(message.type)}Result`,
              ok: true,
              accessToken: 'test-token',
              accountId: 'test-account',
              expiresAt: Date.now() + 60_000,
            });
          },
        },
      },
    });
  });
  let fail = false;
  await page.route('https://chatgpt.com/backend-api/codex/models?*', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    await route.fulfill({
      status: fail ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ slug: 'model-one' }, { slug: 'model-two' }] }),
    });
  });
  await openBuiltEsmHarness(page);
  await page.goto(`${browserOrigin}/example-codex-experimental/workbench.html`);
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect(page.getByLabel('Available models').locator('option')).toHaveText([
    'Select a model',
    'model-one',
    'model-two',
  ]);
  await page.getByLabel('Available models').selectOption('model-two');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('model-two');
  fail = true;
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect(page.getByRole('status')).toContainText('Model discovery unavailable');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('model-two');
});
