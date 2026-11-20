import { createCancellationSource } from '@mgravey/loom-types';
import { describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_API_VERSION,
  AnthropicMessagesModelError,
  createAnthropicDirectTransport,
  createAnthropicMessagesModel,
  type AnthropicDirectTransportOptions,
} from '../src/index.js';

const BODY = JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 10,
  messages: [],
  stream: true,
});
const STREAM =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function setup(
  options: Partial<AnthropicDirectTransportOptions> = {},
  respond: (url: string, init: RequestInit) => Response = () =>
    new Response(STREAM, {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_018EeWyXxfu5pfWkrYcMdjWG',
        'retry-after': '3',
      },
    }),
) {
  const fetch = vi.fn((url: string, init: RequestInit) => Promise.resolve(respond(url, init)));
  const transport = createAnthropicDirectTransport({
    authentication: { type: 'api-key', getApiKey: () => 'sk-ant-api-secret' },
    fetch,
    ...options,
  });
  const headers = (index = 0) =>
    (fetch.mock.calls[index]?.[1]?.headers ?? {}) as Record<string, string>;
  return { fetch, transport, headers };
}

async function text(body: string | AsyncIterable<string>): Promise<string> {
  if (typeof body === 'string') return body;
  let result = '';
  for await (const chunk of body) result += chunk;
  return result;
}

describe('Anthropic direct transport', () => {
  it('sends a user API key as x-api-key with the current version and browser header', async () => {
    const { transport, fetch, headers } = setup({ dangerouslyAllowBrowser: true });
    const response = await transport.send({ body: BODY });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: BODY,
    });
    expect(headers()).toEqual({
      'x-api-key': 'sk-ant-api-secret',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
    });
    expect(ANTHROPIC_API_VERSION).toBe('2026-10-21');
    expect(response).toMatchObject({
      status: 200,
      contentType: 'text/event-stream',
      requestId: 'req_018EeWyXxfu5pfWkrYcMdjWG',
      retryAfterMs: 3000,
    });
    expect(await text(response.body)).toBe(STREAM);
    expect(JSON.stringify(response)).not.toContain('sk-ant');
  });

  it('can send an API key as an Authorization bearer header', async () => {
    const { transport, headers } = setup({
      authentication: {
        type: 'api-key',
        header: 'authorization',
        getApiKey: () => Promise.resolve('sk-ant-api-secret'),
      },
    });
    await text((await transport.send({ body: BODY })).body);
    expect(headers()).toMatchObject({ Authorization: 'Bearer sk-ant-api-secret' });
    expect(headers()).not.toHaveProperty('x-api-key');
    expect(headers()).not.toHaveProperty('anthropic-dangerous-direct-browser-access');
  });

  it('supports linked-billing style bearer tokens with host headers, betas, and body fields', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('oauth-access-secret'));
    const { transport, fetch, headers } = setup({
      authentication: { type: 'bearer', getAccessToken },
      betas: ['user-profiles-billing-2026-10-01', 'another-beta'],
      headers: { 'anthropic-user-profile-id': 'uprof_01HV9Z' },
      bodyFields: { billing_policy: { type: 'billing_policy', bill_to: 'user_profile' } },
      apiVersion: '2026-10-21',
    });
    await text((await transport.send({ body: BODY })).body);
    expect(headers()).toEqual({
      'anthropic-user-profile-id': 'uprof_01HV9Z',
      Authorization: 'Bearer oauth-access-secret',
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'user-profiles-billing-2026-10-01,another-beta',
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      ...(JSON.parse(BODY) as object),
      billing_policy: { type: 'billing_policy', bill_to: 'user_profile' },
    });
    await transport.send({ body: BODY });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ authentication: undefined }],
    [{ authentication: { type: 'api-key' } }],
    [{ authentication: { type: 'api-key', getApiKey: () => 'k', header: 'cookie' } }],
    [{ authentication: { type: 'oauth', getAccessToken: () => 't' } }],
    [{ baseUrl: 'http://api.example.test' }],
    [{ baseUrl: 'https://user:pass@api.example.test' }],
    [{ baseUrl: 'https://api.example.test/?key=1' }],
    [{ baseUrl: 'not a url' }],
    [{ apiVersion: 'latest' }],
    [{ betas: ['bad beta'] }],
    [{ headers: { 'x-api-key': 'override' } }],
    [{ headers: { Authorization: 'Bearer override' } }],
    [{ headers: { 'anthropic-beta': 'x' } }],
    [{ headers: { 'bad header': 'x' } }],
    [{ headers: { 'x-ok': 'line\nbreak' } }],
    [{ bodyFields: { model: 'other' } }],
    [{ bodyFields: { max_tokens: 1 } }],
    [{ dangerouslyAllowBrowser: 'yes' }],
    [{ fetch: 'fetch' }],
  ])('rejects invalid configuration %j', (overrides) => {
    expect(() =>
      createAnthropicDirectTransport({
        authentication: { type: 'api-key', getApiKey: () => 'k' },
        fetch: vi.fn(),
        ...(overrides as object),
      } as AnthropicDirectTransportOptions),
    ).toThrow(AnthropicMessagesModelError);
    expect(() => createAnthropicDirectTransport(null as never)).toThrow('authentication');
  });

  it('accepts HTTPS and loopback base URLs', async () => {
    for (const baseUrl of ['https://proxy.example.test/anthropic/', 'http://127.0.0.1:8080']) {
      const { transport, fetch } = setup({ baseUrl });
      await transport.send({ body: BODY });
      expect(fetch.mock.calls[0]?.[0]).toBe(`${baseUrl.replace(/\/$/u, '')}/v1/messages`);
    }
  });

  it('sanitizes credential callback and network failures', async () => {
    for (const getApiKey of [
      () => Promise.reject(new Error('sk-ant-leaked')),
      () => '',
      () => 'key\nwith-newline',
      () => 42 as unknown as string,
    ]) {
      const { transport, fetch } = setup({ authentication: { type: 'api-key', getApiKey } });
      const error = await transport.send({ body: BODY }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      expect(String(error) + JSON.stringify(error)).not.toContain('sk-ant');
      expect(fetch).not.toHaveBeenCalled();
    }
    const network = createAnthropicDirectTransport({
      authentication: { type: 'api-key', getApiKey: () => 'sk-ant-api-secret' },
      fetch: () => Promise.reject(new Error('TypeError: Failed to fetch sk-ant-api-secret')),
    });
    const error = await network.send({ body: BODY }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'TRANSPORT_FAILED', retryable: true });
    expect(String(error) + JSON.stringify(error)).not.toContain('sk-ant');
    await expect(network.send({ body: 1 as never })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    const fields = setup({ bodyFields: { metadata: { user_id: 'u' } } });
    await expect(fields.transport.send({ body: '[' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(fields.transport.send({ body: '[]' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('aborts fetch and stream reads on cancellation', async () => {
    const source = createCancellationSource();
    const { transport, fetch } = setup({}, (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const response = await transport.send({ body: BODY, signal: source.signal });
    const iterator = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain('ping');
    const pending = iterator.next();
    source.cancel('user');
    await expect(pending).rejects.toMatchObject({ name: 'CancellationError' });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const already = createCancellationSource();
    already.cancel();
    await expect(transport.send({ body: BODY, signal: already.signal })).rejects.toMatchObject({
      name: 'CancellationError',
    });
  });

  it('reports interrupted response streams without exposing the cause', async () => {
    const { transport } = setup({}, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('socket secret'));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const error = await text((await transport.send({ body: BODY })).body).catch(
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(String(error)).not.toContain('secret');
  });

  it('streams through the model adapter end to end', async () => {
    const { transport } = setup({ dangerouslyAllowBrowser: true });
    const model = createAnthropicMessagesModel({ model: 'claude-haiku-5-5', transport });
    const events = [];
    for await (const event of model.generate({
      instructions: 'Be brief.',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
    }))
      events.push(event);
    expect(events).toContainEqual({ type: 'text', text: 'Hi' });
    expect(events.at(-1)).toEqual({ type: 'completed', final: true });
  });

  it('passes HTTP errors with request metadata to the model for sanitized mapping', async () => {
    const { transport } = setup(
      {},
      () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'secret' } }),
          { status: 529, headers: { 'content-type': 'application/json', 'request-id': 'req_9' } },
        ),
    );
    const model = createAnthropicMessagesModel({ model: 'claude-opus-5-5', transport });
    const stream = model.generate({
      instructions: '',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      status: 529,
      providerCode: 'overloaded_error',
      retryable: true,
      requestId: 'req_9',
    });
  });
});

describe('Anthropic model listing', () => {
  it('paginates GET /v1/models and maps bounded model information', async () => {
    const pages = [
      {
        data: [
          {
            type: 'model',
            id: 'claude-opus-5-5',
            display_name: 'Claude Opus 5.5',
            created_at: '2026-09-21T00:00:00Z',
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
          },
          { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
          { type: 'model', id: '' },
          'garbage',
        ],
        has_more: true,
        last_id: 'claude-sonnet-5-5',
      },
      {
        data: [
          { type: 'model', id: 'claude-haiku-5-5', max_tokens: 0 },
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Duplicate' },
        ],
        has_more: false,
        last_id: 'claude-haiku-5-5',
      },
    ];
    let page = 0;
    const { transport, fetch, headers } = setup({ dangerouslyAllowBrowser: true }, () =>
      Response.json(pages[page++]),
    );
    expect(await transport.listModels()).toEqual([
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        createdAt: '2026-09-21T00:00:00Z',
        maxInputTokens: 1_000_000,
        maxTokens: 128_000,
      },
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', displayName: 'claude-haiku-5-5' },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=998&after_id=claude-sonnet-5-5',
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(headers()).toEqual({
      'x-api-key': 'sk-ant-api-secret',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
      Accept: 'application/json',
    });
  });

  it('honours limits and reports sanitized catalog failures', async () => {
    const limited = setup({}, () =>
      Response.json({
        data: [{ id: 'a' }, { id: 'b' }],
        has_more: true,
        last_id: 'b',
      }),
    );
    expect(await limited.transport.listModels({ limit: 1 })).toEqual([
      { id: 'a', displayName: 'a' },
    ]);
    await expect(limited.transport.listModels({ limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    const denied = setup({}, () =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'sk-ant-secret' } },
        { status: 401, headers: { 'request-id': 'req_1' } },
      ),
    );
    const error = await denied.transport.listModels().catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      providerCode: 'authentication_error',
      requestId: 'req_1',
      retryable: false,
    });
    expect(String(error) + JSON.stringify(error)).not.toContain('secret');
    const html = setup({}, () => new Response('<html>secret</html>', { status: 502 }));
    await expect(html.transport.listModels()).rejects.toMatchObject({
      status: 502,
      retryable: true,
      providerCode: undefined,
    });
    const malformed = setup({}, () => Response.json({ models: [] }));
    await expect(malformed.transport.listModels()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
    const invalid = setup({}, () => new Response('not json'));
    await expect(invalid.transport.listModels()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
    const offline = createAnthropicDirectTransport({
      authentication: { type: 'bearer', getAccessToken: () => 'token' },
      fetch: () => Promise.reject(new Error('offline')),
    });
    await expect(offline.listModels()).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    const cancelled = createCancellationSource();
    cancelled.cancel();
    await expect(limited.transport.listModels({ signal: cancelled.signal })).rejects.toMatchObject({
      name: 'CancellationError',
    });
  });
});
