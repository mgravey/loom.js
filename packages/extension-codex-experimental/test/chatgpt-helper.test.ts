import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_HELPER_CALLBACK_PROTOCOL,
  CHATGPT_HELPER_CHUNK_WINDOW,
  CHATGPT_HELPER_ENABLED_KEY,
  CHATGPT_HELPER_PORT_NAME,
  CHATGPT_HELPER_PROTOCOL,
  CHATGPT_HELPER_REDIRECT_URI,
  CHATGPT_HELPER_RULE_ID_BASE,
  CHATGPT_HELPER_VERSION,
  isChatGPTHelperRequest,
  type ChatGPTHelperFetchResponse,
} from '../src/chatgpt-helper.js';
import {
  connectCompanionChatGPTHelper,
  createCompanionChatGPTHelper,
  getCompanionChatGPTHelperStatus,
} from '../../companion-codex-experimental/src/chatgpt-helper.js';
import { createHelperFixture, EXTENSION_ID, type HelperFixture } from './chatgpt-helper-fixture.js';

const SITE = 'https://app.example.test';
const OTHER = 'https://other.example.test';
const STATE = 'state-value-0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
});

function authorizationUrl(overrides: Record<string, string> = {}, extra = ''): string {
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  url.search = new URLSearchParams({
    client_id: 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: CHATGPT_HELPER_REDIRECT_URI,
    scope: 'openid',
    state: STATE,
    nonce: 'nonce',
    code_challenge_method: 'S256',
    code_challenge: 'challenge',
    ...overrides,
  }).toString();
  return url.href + extra;
}

function helperFor(f: HelperFixture, origin = SITE, fallbackFetch = vi.fn()) {
  return createCompanionChatGPTHelper({
    runtime: f.runtimeFor(origin),
    extensionId: EXTENSION_ID,
    redirectUri: CHATGPT_HELPER_REDIRECT_URI,
    fallbackFetch,
  });
}

function approvedFixture() {
  const f = createHelperFixture();
  f.approved.add(SITE);
  return f;
}

async function signInTab(f: HelperFixture, count = 1): Promise<number> {
  await vi.waitFor(() => expect(f.tabUrls.size).toBe(count));
  return [...f.tabUrls.keys()].at(-1) ?? -1;
}

function streamResponse(
  chunks: readonly string[],
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const encoder = new TextEncoder();
  let index = 0;
  const pulled = { count: 0 };
  const cancelled = { value: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled.count += 1;
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        cancelled.value = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response: ChatGPTHelperFetchResponse = {
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    body,
  };
  return { response, pulled, cancelled };
}

describe('ChatGPT helper status', () => {
  it('reports each unavailable reason and the redirect only to approved, enabled origins', async () => {
    const f = createHelperFixture();
    const status = (origin: string) =>
      getCompanionChatGPTHelperStatus({ runtime: f.runtimeFor(origin), extensionId: EXTENSION_ID });
    expect(await status(SITE)).toEqual({ available: false, reason: 'origin-not-approved' });
    expect(await status('http://plain.example.test')).toEqual({
      available: false,
      reason: 'origin-not-approved',
    });
    f.approved.add(SITE);
    f.values.set(CHATGPT_HELPER_ENABLED_KEY, false);
    expect(await status(SITE)).toEqual({ available: false, reason: 'helper-disabled' });
    f.values.set(CHATGPT_HELPER_ENABLED_KEY, true);
    f.permissions.granted = false;
    expect(await status(SITE)).toEqual({ available: false, reason: 'helper-disabled' });
    f.permissions.granted = true;
    expect(await status(SITE)).toEqual({
      available: true,
      redirectUri: CHATGPT_HELPER_REDIRECT_URI,
    });
    const connected = await connectCompanionChatGPTHelper({
      runtime: f.runtimeFor(SITE),
      extensionId: EXTENSION_ID,
    });
    expect(connected.helper?.clientOptions.redirectBroker.redirectUri).toBe(
      CHATGPT_HELPER_REDIRECT_URI,
    );
    expect(
      (
        await connectCompanionChatGPTHelper({
          runtime: f.runtimeFor(OTHER),
          extensionId: EXTENSION_ID,
        })
      ).helper,
    ).toBeUndefined();
  });

  it('treats a missing runtime or extension as unavailable', async () => {
    expect(await getCompanionChatGPTHelperStatus({ runtime: () => undefined as never })).toEqual({
      available: false,
      reason: 'extension-unavailable',
    });
    const runtime = {
      lastError: { message: 'Could not establish connection.' },
      sendMessage: (_id: string, _m: unknown, _o: undefined, callback: (r: unknown) => void) =>
        callback(undefined),
      connect: () => {
        throw new Error('no');
      },
    };
    expect(await getCompanionChatGPTHelperStatus({ runtime })).toEqual({
      available: false,
      reason: 'extension-unavailable',
    });
  });

  it('rejects malformed status requests and only claims its own protocol', async () => {
    const f = approvedFixture();
    const reply = await new Promise((resolve) =>
      f.helper.externalMessageListener(
        { protocol: CHATGPT_HELPER_PROTOCOL, version: 1, type: 'getStatus', requestId: 'r', x: 1 },
        { origin: SITE, url: `${SITE}/` },
        resolve,
      ),
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(isChatGPTHelperRequest({ protocol: CHATGPT_HELPER_PROTOCOL })).toBe(true);
    expect(isChatGPTHelperRequest({ protocol: 'loom/responses' })).toBe(false);
    expect(() =>
      createCompanionChatGPTHelper({
        runtime: f.runtimeFor(SITE),
        redirectUri: 'https://127.0.0.1/auth/callback',
      }),
    ).toThrow(TypeError);
  });
});

describe('ChatGPT helper redirect capture', () => {
  it('captures the loopback callback in its own tab and returns it only to the initiating page', async () => {
    const f = approvedFixture();
    const helper = helperFor(f);
    const controller = new AbortController();
    const result = helper.redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: controller.signal,
    });
    const tabId = await signInTab(f);
    expect(f.tabUrls.get(tabId)).toBe(authorizationUrl());
    expect(f.chromeApi.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'about:blank', type: 'popup' }),
    );
    const [rule] = [...f.rules.values()];
    expect(rule?.id).toBe(CHATGPT_HELPER_RULE_ID_BASE);
    expect(rule?.condition).toMatchObject({ tabIds: [tabId], resourceTypes: ['main_frame'] });
    // Another tab navigating to the same loopback URL is not redirected.
    expect((await f.navigate(tabId + 50, `${CHATGPT_HELPER_REDIRECT_URI}?code=x`)).redirected).toBe(
      `${CHATGPT_HELPER_REDIRECT_URI}?code=x`,
    );
    const callback = `${CHATGPT_HELPER_REDIRECT_URI}?code=code%2Bsecret&state=${STATE}&client_id=oaiapp_x`;
    const navigation = await f.navigate(tabId, callback);
    expect(navigation.redirected).toMatch(
      new RegExp(
        `^chrome-extension://${EXTENSION_ID}/chatgpt-callback\\.html\\?loom_attempt=`,
        'u',
      ),
    );
    expect(navigation.response).toEqual({ ok: true });
    await expect(result).resolves.toEqual({ status: 'callback', url: callback });
    expect(f.rules.size).toBe(0);
    expect(f.windows.size).toBe(0);
    // Replaying the callback after completion is not accepted.
    expect((await f.navigate(tabId, callback)).response).toBeUndefined();
  });

  it.each([
    ['a different state', `?code=c&state=${STATE}x`],
    ['a duplicated state', `?code=c&state=${STATE}&state=${STATE}`],
    ['a smuggled attempt identifier', `?code=c&state=${STATE}&loom_attempt=x`],
  ])('fails closed on a callback with %s', async (_label, query) => {
    const f = approvedFixture();
    const result = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: new AbortController().signal,
    });
    const tabId = await signInTab(f);
    expect((await f.navigate(tabId, `${CHATGPT_HELPER_REDIRECT_URI}${query}`)).response).toEqual({
      ok: false,
    });
    await expect(result).resolves.toEqual({ status: 'failed' });
    expect(f.rules.size).toBe(0);
  });

  it('ignores callback messages from other tabs or senders', async () => {
    const f = approvedFixture();
    const result = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: new AbortController().signal,
    });
    const tabId = await signInTab(f);
    const send = (sender: Parameters<typeof f.helper.callbackMessageListener>[1], search: string) =>
      new Promise((resolve) =>
        f.helper.callbackMessageListener(
          { protocol: CHATGPT_HELPER_CALLBACK_PROTOCOL, version: CHATGPT_HELPER_VERSION, search },
          sender,
          resolve,
        ),
      );
    const page = `chrome-extension://${EXTENSION_ID}/chatgpt-callback.html`;
    const search = `?code=c&state=${STATE}`;
    expect(await send({ id: EXTENSION_ID, url: page, tab: { id: tabId + 1 } }, search)).toEqual({
      ok: false,
    });
    expect(await send({ id: 'other-extension', url: page, tab: { id: tabId } }, search)).toEqual({
      ok: false,
    });
    expect(
      await send(
        {
          id: EXTENSION_ID,
          url: `chrome-extension://${EXTENSION_ID}/options.html`,
          tab: { id: tabId },
        },
        search,
      ),
    ).toEqual({ ok: false });
    expect(f.helper.callbackMessageListener({ protocol: 'other' }, {}, vi.fn())).toBeUndefined();
    expect(f.windows.size).toBe(1);
    f.chromeApi.tabs.onRemoved.addListener(() => undefined);
    await f.chromeApi.windows.remove([...f.windows.keys()][0] ?? 0);
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('cancels when the page aborts, closing the window and removing the rule', async () => {
    const f = approvedFixture();
    const controller = new AbortController();
    const result = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: controller.signal,
    });
    await signInTab(f);
    controller.abort();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    await vi.waitFor(() => expect(f.windows.size).toBe(0));
    expect(f.rules.size).toBe(0);
  });

  it('expires an abandoned attempt', async () => {
    vi.useFakeTimers();
    const f = approvedFixture();
    const result = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.tabUrls.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(f.windows.size).toBe(0);
  });

  it.each([
    ['another host', authorizationUrl().replace('auth.openai.com', 'auth.example.test')],
    ['another redirect', authorizationUrl({ redirect_uri: 'http://127.0.0.1:9/auth/callback' })],
    ['plain PKCE', authorizationUrl({ code_challenge_method: 'plain' })],
    ['a mismatched state', authorizationUrl({ state: `${STATE}-other` })],
    ['a duplicated parameter', authorizationUrl({}, '&scope=x')],
    ['a fragment', authorizationUrl({}, '#x')],
  ])('refuses an authorization URL with %s before opening a window', async (_label, url) => {
    const f = approvedFixture();
    await expect(
      helperFor(f).redirectBroker.authorize({
        authorizationUrl: url,
        state: STATE,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: 'failed' });
    expect(f.chromeApi.windows.create).not.toHaveBeenCalled();
  });

  it('is unavailable to unapproved origins and while the helper is disabled', async () => {
    const f = approvedFixture();
    const request = {
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal: new AbortController().signal,
    };
    await expect(helperFor(f, OTHER).redirectBroker.authorize(request)).resolves.toEqual({
      status: 'unavailable',
    });
    f.values.delete(CHATGPT_HELPER_ENABLED_KEY);
    await expect(helperFor(f).redirectBroker.authorize(request)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(f.chromeApi.windows.create).not.toHaveBeenCalled();
  });

  it('keeps concurrent attempts from two tabs of one site apart and bounds them', async () => {
    const f = approvedFixture();
    const signal = new AbortController().signal;
    const first = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl(),
      state: STATE,
      signal,
    });
    const firstTab = await signInTab(f, 1);
    const secondState = `${STATE}-second`;
    const second = helperFor(f).redirectBroker.authorize({
      authorizationUrl: authorizationUrl({ state: secondState }),
      state: secondState,
      signal,
    });
    const secondTab = await signInTab(f, 2);
    await expect(
      helperFor(f).redirectBroker.authorize({
        authorizationUrl: authorizationUrl(),
        state: STATE,
        signal,
      }),
    ).resolves.toEqual({ status: 'failed' });
    // The first tab's callback carrying the second attempt's state is rejected for the first.
    await f.navigate(secondTab, `${CHATGPT_HELPER_REDIRECT_URI}?code=two&state=${secondState}`);
    await expect(second).resolves.toEqual({
      status: 'callback',
      url: `${CHATGPT_HELPER_REDIRECT_URI}?code=two&state=${secondState}`,
    });
    await f.navigate(firstTab, `${CHATGPT_HELPER_REDIRECT_URI}?code=one&state=${STATE}`);
    await expect(first).resolves.toEqual({
      status: 'callback',
      url: `${CHATGPT_HELPER_REDIRECT_URI}?code=one&state=${STATE}`,
    });
  });

  it('removes stale rules left by a stopped service worker', async () => {
    const f = approvedFixture();
    await f.helper.removeStaleRules();
    expect(f.chromeApi.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [0, 1, 2, 3].map((index) => CHATGPT_HELPER_RULE_ID_BASE + index),
    });
  });
});

describe('ChatGPT helper relay', () => {
  it('relays only the allowlisted requests with fixed headers and no credentials', async () => {
    const f = approvedFixture();
    const fallback = vi.fn(() => Promise.resolve(new Response('direct')));
    const helper = helperFor(f, SITE, fallback);
    f.upstream.mockImplementation(() =>
      Promise.resolve(
        streamResponse(['{"issuer":', '"https://auth.openai.com"}'], {
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_1',
            'set-cookie': 'a=b',
          },
        }).response,
      ),
    );
    const response = await helper.fetch(
      'https://auth.openai.com/.well-known/openid-configuration',
      { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json', Cookie: 'x' } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ issuer: 'https://auth.openai.com' });
    expect(f.upstream).toHaveBeenCalledWith(
      'https://auth.openai.com/.well-known/openid-configuration',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    // Token exchange and everything else go to the page's own fetch, not through the extension.
    await helper.fetch('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST' });
    await helper.fetch('https://api.openai.com/v1/models?x=1', { method: 'GET' });
    await helper.fetch('https://api.openai.com/v1/responses', { method: 'GET' });
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(f.upstream).toHaveBeenCalledOnce();
  });

  it('streams responses with a per-request bearer and bounded in-flight chunks', async () => {
    const f = approvedFixture();
    const helper = helperFor(f);
    const chunks = Array.from({ length: 30 }, (_, index) => `data: ${String(index)}\n\n`);
    const upstream = streamResponse(chunks);
    f.upstream.mockResolvedValue(upstream.response);
    const response = await helper.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer access-secret', 'Content-Type': 'application/json' },
      body: '{"model":"m","stream":true}',
    });
    expect(response.headers.get('content-type')).toBeNull();
    const call = f.upstream.mock.calls[0]?.[1];
    expect(call?.headers).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer access-secret',
      'Content-Type': 'application/json',
    });
    expect(call?.body).toBe('{"model":"m","stream":true}');
    // Nothing is consumed yet: the extension stops reading once its window is full.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstream.pulled.count).toBeLessThanOrEqual(CHATGPT_HELPER_CHUNK_WINDOW + 2);
    expect(await response.text()).toBe(chunks.join(''));
    expect(f.ports.every((pair) => !pair.isConnected())).toBe(true);
  });

  it('propagates page aborts to the upstream request', async () => {
    const f = approvedFixture();
    const helper = helperFor(f);
    let upstreamSignal: AbortSignal | undefined;
    const upstream = streamResponse(Array.from({ length: 100 }, () => 'data: x\n\n'));
    f.upstream.mockImplementation((_url, init) => {
      upstreamSignal = init.signal;
      return Promise.resolve(upstream.response);
    });
    const controller = new AbortController();
    const response = await helper.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer access-secret' },
      body: '{}',
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await expect(reader?.read()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(upstream.cancelled.value).toBe(true));
    await expect(
      helper.fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes a bounded error body and status through for classification', async () => {
    const f = approvedFixture();
    const big = `{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}${' '.repeat(40_000)}`;
    f.upstream.mockResolvedValue(
      streamResponse([big], { status: 429, headers: { 'content-type': 'application/json' } })
        .response,
    );
    const response = await helperFor(f).fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text.length).toBe(16 * 1024);
    expect(text.startsWith('{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}')).toBe(
      true,
    );
  });

  it('fails a success body above the target limit', async () => {
    const f = approvedFixture();
    f.upstream.mockResolvedValue(streamResponse(['x'.repeat(70 * 1024)]).response);
    const response = await helperFor(f).fetch('https://auth.openai.com/.well-known/jwks.json', {});
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects unapproved pages, unreachable upstreams, and non-string bodies', async () => {
    const f = approvedFixture();
    await expect(
      helperFor(f, OTHER).fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer t' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(f.upstream).not.toHaveBeenCalled();
    f.upstream.mockRejectedValue(new Error('network secret detail'));
    const error = await helperFor(f)
      .fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer t' } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain('secret');
    await expect(
      helperFor(f).fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    [{ target: 'https://evil.example.test/' }],
    [{ target: 'openid-configuration', authorization: 'Bearer t' }],
    [{ target: 'models' }],
    [{ target: 'models', authorization: 'Basic abc' }],
    [{ target: 'responses', authorization: 'Bearer t', body: 'not json' }],
    [{ target: 'responses', authorization: 'Bearer t', body: '[]' }],
    [{ target: 'models', authorization: 'Bearer t', body: '{}' }],
    [{ target: 'models', authorization: 'Bearer t', url: 'https://evil.example.test' }],
  ])('refuses relay request %j without contacting the network', async (fields) => {
    const f = approvedFixture();
    const port = f.runtimeFor(SITE).connect(EXTENSION_ID, { name: CHATGPT_HELPER_PORT_NAME });
    const reply = new Promise((resolve) => port.onMessage.addListener(resolve));
    port.postMessage({
      protocol: CHATGPT_HELPER_PROTOCOL,
      version: CHATGPT_HELPER_VERSION,
      type: 'fetch',
      requestId: 'raw-1',
      ...fields,
    });
    await expect(reply).resolves.toMatchObject({
      type: 'error',
      requestId: 'raw-1',
      code: 'INVALID_REQUEST',
    });
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it('stops a running relay promptly when the website approval is revoked', async () => {
    const f = approvedFixture();
    const upstream = streamResponse(Array.from({ length: 100 }, () => 'data: x\n\n'));
    f.upstream.mockResolvedValue(upstream.response);
    const response = await helperFor(f).fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: '{}',
    });
    const reader = response.body?.getReader();
    await reader?.read();
    f.approved.delete(SITE);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
    let failure: unknown;
    try {
      for (;;) if ((await reader?.read())?.done !== false) break;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    await vi.waitFor(() => expect(upstream.cancelled.value).toBe(true));
  });

  it('ignores ports with other names', () => {
    const f = approvedFixture();
    const port = { name: 'loom/responses/v1', onMessage: { addListener: vi.fn() } };
    f.helper.portListener(port as never);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });
});
