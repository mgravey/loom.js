import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  createChatGPTBrowserClient,
  type ChatGPTBrowserClient,
  type ChatGPTBrowserPersistedSession,
} from '../src/index.js';
import { connectCompanionChatGPTHelper } from '../../companion-codex-experimental/src/chatgpt-helper.js';
import {
  createHelperFixture,
  EXTENSION_ID,
} from '../../extension-codex-experimental/test/chatgpt-helper-fixture.js';
import type { ChatGPTHelperFetch } from '../../extension-codex-experimental/src/chatgpt-helper.js';

/**
 * End to end without a network: the real page client, the Companion page adapter, and the real
 * extension helper connected through in-memory Chrome ports. OpenAI is mocked on both sides: the
 * page may only reach the token endpoint directly; everything else must come through the relay.
 */
const SITE = 'https://studio.example.test';
const AUTH = 'https://auth.openai.com';
const CLIENT = 'oaiapp_companion_test';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;
const clients: ChatGPTBrowserClient[] = [];

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.unstubAllGlobals();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function setup() {
  vi.stubGlobal('window', {
    location: new URL(`${SITE}/workspace`),
    open: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const f = createHelperFixture();
  f.approved.add(SITE);
  let nonce = '';
  let accessCounter = 0;
  const sign = () => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: AUTH,
      sub: 'subject',
      aud: CLIENT,
      iat: now,
      exp: now + 3600,
      nonce,
      email: 'user@example.test',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
      .sign(keys.privateKey);
  };
  // The page's own network: only the token endpoint is CORS-readable.
  const pageFetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== `${AUTH}/api/accounts/oauth/token`) throw new TypeError('Failed to fetch');
    accessCounter += 1;
    const form = new URLSearchParams(init.body as URLSearchParams);
    return json({
      access_token: `access-secret-${String(accessCounter)}`,
      refresh_token: `refresh-secret-${String(accessCounter)}`,
      id_token: await sign(),
      scope: form.get('grant_type') === 'refresh_token' ? undefined : SCOPE,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });
  // The extension's network.
  f.upstream.mockImplementation(((url: string) => {
    if (url === `${AUTH}/.well-known/openid-configuration`)
      return Promise.resolve(json({ issuer: AUTH, jwks_uri: `${AUTH}/.well-known/jwks.json` }));
    if (url === `${AUTH}/.well-known/jwks.json`) return Promise.resolve(json(jwks));
    if (url === 'https://api.openai.com/v1/models')
      return Promise.resolve(
        json({ models: [{ slug: 'model-a', display_name: 'Model A', visibility: 'list' }] }),
      );
    if (url === 'https://api.openai.com/v1/responses')
      // Like the live service: a valid stream without a Content-Type header.
      return Promise.resolve(
        new Response(
          new Blob([
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi' })}\r\n\r\n`,
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\r\n\r\n`,
          ]).stream(),
        ),
      );
    return Promise.reject(new Error('Unexpected upstream'));
  }) as ChatGPTHelperFetch);
  const connected = await connectCompanionChatGPTHelper({
    runtime: f.runtimeFor(SITE),
    extensionId: EXTENSION_ID,
    fallbackFetch: pageFetch,
  });
  if (connected.helper === undefined) throw new Error('Helper unavailable');
  const helper = connected.helper;
  let saved: ChatGPTBrowserPersistedSession | undefined;
  const sessionStore = {
    load: () => Promise.resolve(saved),
    save: vi.fn((value: ChatGPTBrowserPersistedSession) => {
      saved = value;
      return Promise.resolve();
    }),
    clear: () => {
      saved = undefined;
      return Promise.resolve();
    },
  };
  const create = () => {
    const client = createChatGPTBrowserClient({
      appName: 'Companion test',
      storage: null,
      sessionStore,
      ...helper.clientOptions,
    });
    clients.push(client);
    return client;
  };
  const signIn = async (client: ChatGPTBrowserClient) => {
    const pending = client.signIn();
    await vi.waitFor(() => expect(f.tabUrls.size).toBeGreaterThan(0));
    const [tabId, authorizeUrl] = [...f.tabUrls.entries()].at(-1) ?? [0, ''];
    const authorization = new URL(authorizeUrl);
    nonce = authorization.searchParams.get('nonce') ?? '';
    const state = authorization.searchParams.get('state') ?? '';
    await f.navigate(
      tabId,
      `http://127.0.0.1:1456/auth/callback?code=code-secret&state=${state}&client_id=${CLIENT}`,
    );
    await pending;
  };
  return { f, pageFetch, helper, create, signIn, sessionStore };
}

async function consume(client: ChatGPTBrowserClient): Promise<string> {
  const response = await client.transport.send({
    body: JSON.stringify({ model: 'model-a', input: [] }),
  });
  let result = '';
  for await (const chunk of response.body) result += chunk;
  return result;
}

describe('Sign in with ChatGPT through the Loom.js Companion helper', () => {
  it('signs in on a public origin, lists models, and streams a response', async () => {
    const h = await setup();
    const client = h.create();
    expect(client.getStatus()).toMatchObject({ supported: true });
    await h.signIn(client);
    expect(client.getStatus()).toMatchObject({ authenticated: true, planEnabled: true });
    expect(window.open).not.toHaveBeenCalled();
    expect(await client.listModels()).toEqual([{ slug: 'model-a', displayName: 'Model A' }]);
    expect(await consume(client)).toContain('Hi');
    const relayed = h.f.upstream.mock.calls.map(([url, init]) => [url, init.headers.Authorization]);
    expect(relayed).toEqual([
      [`${AUTH}/.well-known/openid-configuration`, undefined],
      [`${AUTH}/.well-known/jwks.json`, undefined],
      ['https://api.openai.com/v1/models', 'Bearer access-secret-1'],
      ['https://api.openai.com/v1/responses', 'Bearer access-secret-1'],
    ]);
    // The code exchange stayed on the page; the extension stored nothing secret.
    expect(h.pageFetch).toHaveBeenCalledOnce();
    expect(JSON.stringify([...h.f.values])).not.toMatch(/secret/u);
    expect(h.f.windows.size).toBe(0);
    expect(h.f.rules.size).toBe(0);
  });

  it('restores a saved session after reload with refresh and calls going through the relay', async () => {
    const h = await setup();
    const first = h.create();
    await h.signIn(first);
    await vi.waitFor(() => expect(h.sessionStore.save).toHaveBeenCalled());
    first.dispose();
    h.f.upstream.mockClear();
    h.pageFetch.mockClear();
    const reloaded = h.create();
    expect(await reloaded.restoreSession()).toBe('restored');
    expect(h.f.chromeApi.windows.create).toHaveBeenCalledOnce();
    expect(h.pageFetch.mock.calls.map(([url]) => url)).toEqual([
      `${AUTH}/api/accounts/oauth/token`,
    ]);
    expect(await reloaded.listModels()).toHaveLength(1);
    expect(await consume(reloaded)).toContain('Hi');
    expect(h.f.upstream.mock.calls.map(([url, init]) => [url, init.headers.Authorization])).toEqual(
      [
        [`${AUTH}/.well-known/openid-configuration`, undefined],
        [`${AUTH}/.well-known/jwks.json`, undefined],
        ['https://api.openai.com/v1/models', 'Bearer access-secret-2'],
        ['https://api.openai.com/v1/responses', 'Bearer access-secret-2'],
      ],
    );
  });

  it('reports a revoked website approval as a sanitized, typed failure', async () => {
    const h = await setup();
    const client = h.create();
    await h.signIn(client);
    h.f.approved.delete(SITE);
    await expect(client.listModels()).rejects.toMatchObject({ kind: 'temporarily-unavailable' });
    const pending = client.signIn();
    await expect(pending).rejects.toMatchObject({ kind: 'unsupported-environment' });
  });
});
