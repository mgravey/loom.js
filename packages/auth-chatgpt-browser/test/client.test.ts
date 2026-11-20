import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createCancellationSource } from '@mgravey/loom-types';
import { createOpenAICompatibleResponsesModel } from '@mgravey/loom-model-openai-responses';

import {
  ChatGPTBrowserError,
  createChatGPTBrowserClient,
  type ChatGPTBrowserClient,
  type ChatGPTBrowserClientOptions,
} from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:4174';
const AUTH = 'https://auth.openai.com';
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const CLIENT = 'oaiapp_local_test';
const CALLBACK = 'loom/chatgpt-browser/callback';
const LOCAL_URL = `${'http://127.0.0.1:4174'}/app.html`;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;
const clients: ChatGPTBrowserClient[] = [];

beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  otherKeys = await generateKeyPair('ES256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const sse = (...events: unknown[]) =>
  new Response(
    events
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`)
      .join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };

function harness(origin = ORIGIN, extra: Partial<ChatGPTBrowserClientOptions> = {}) {
  const storage = new Map<string, string>();
  const listeners = new Set<(event: MessageEvent) => void>();
  const popups: {
    closed: boolean;
    location: { replace: ReturnType<typeof vi.fn> };
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const open = vi.fn(() => {
    const popup = { closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    popup.close.mockImplementation(() => {
      popup.closed = true;
    });
    popups.push(popup);
    return popup;
  });
  vi.stubGlobal('window', {
    location: new URL(`${origin}/app.html?view=agent`),
    open,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    sessionStorage: {
      setItem: () => {
        throw new Error('Session storage must not be used');
      },
    },
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  });
  let grant: Record<string, unknown> = {};
  let claims: Record<string, unknown> = {};
  let wrongSignature = false;
  let revokeEndpoint = `${AUTH}/oauth/revoke`;
  let revokeStatus = 200;
  let tokenGate: ReturnType<typeof deferred<Response>> | undefined;
  let refreshGate: ReturnType<typeof deferred<Response>> | undefined;
  let revokeGate: ReturnType<typeof deferred<Response>> | undefined;
  let streamResponse: () => Response = () => sse(completed);
  const sign = async (nonce: string, issued = CLIENT, overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: AUTH,
      sub: 'verified-subject',
      aud: issued,
      iat: now,
      exp: now + 3600,
      nonce,
      email: 'alice@example.test',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
      .sign(wrongSignature ? otherKeys.privateKey : keys.privateKey);
  };
  const authorization = () => {
    const latest = popups.at(-1)?.location.replace.mock.calls[0]?.[0] as string | undefined;
    if (latest === undefined) throw new Error('No authorization navigation');
    return new URL(latest);
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === `${AUTH}/.well-known/openid-configuration`)
      return json({
        issuer: AUTH,
        jwks_uri: `${AUTH}/.well-known/jwks.json`,
        revocation_endpoint: revokeEndpoint,
      });
    if (url === `${AUTH}/.well-known/jwks.json`) return json(jwks);
    if (url === TOKEN) {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      if (form.get('grant_type') === 'refresh_token') {
        return (
          refreshGate?.promise ??
          json({
            access_token: 'rotated-access-secret',
            refresh_token: 'rotated-refresh-secret',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
      }
      if (tokenGate !== undefined) return tokenGate.promise;
      return json({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: await sign(
          authorization().searchParams.get('nonce') ?? '',
          form.get('client_id') ?? '',
          claims,
        ),
        scope: SCOPE,
        token_type: 'Bearer',
        expires_in: 3600,
        ...grant,
      });
    }
    if (url === `${AUTH}/oauth/revoke`)
      return revokeGate?.promise ?? new Response(null, { status: revokeStatus });
    if (url === `${RESOURCE}/models`)
      return json({
        models: [
          { slug: 'model-b', display_name: 'Model B', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
          { slug: 'model-a', display_name: 'Model A', visibility: 'list' },
          { slug: 'model-b', display_name: 'Duplicate', visibility: 'list' },
        ],
      });
    if (url === `${RESOURCE}/responses`) return streamResponse();
    throw new Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetchMock);
  const create = () => {
    const client = createChatGPTBrowserClient({
      appName: 'Loom.js',
      notices: {
        ready: 'Local browser sign-in is experimental.',
        unsupported: () => `Local test only. Open ${LOCAL_URL}.`,
      },
      ...extra,
    });
    clients.push(client);
    return client;
  };
  const client = create();
  const message = (url: string, options: { origin?: string; source?: unknown } = {}) => {
    const event = {
      origin: options.origin ?? origin,
      source: options.source ?? popups.at(-1),
      data: { type: CALLBACK, url },
    } as MessageEvent;
    listeners.forEach((listener) => listener(event));
  };
  const callbackUrl = (fields: Record<string, string> = {}) => {
    const params = new URLSearchParams({
      state: authorization().searchParams.get('state') ?? '',
      code: 'authorization-code-secret',
      client_id: CLIENT,
      ...fields,
    });
    return `${origin}/auth/callback?${params.toString()}`;
  };
  const start = async (accountId?: string) => {
    const promise = client.signIn(accountId);
    // Attach a handler immediately so intentional cancellations do not cause unhandled rejection noise.
    void promise.catch(() => undefined);
    await vi.waitFor(() => expect(popups.at(-1)?.location.replace).toHaveBeenCalledOnce());
    return { promise, url: authorization() };
  };
  const login = async (accountId?: string) => {
    const pending = await start(accountId);
    message(callbackUrl(accountId === undefined ? {} : { client_id: accountId }));
    await pending.promise;
  };
  return {
    client,
    create,
    storage,
    popups,
    open,
    listeners,
    fetchMock,
    sign,
    authorization,
    start,
    login,
    callbackUrl,
    message,
    setGrant: (value: Record<string, unknown>) => {
      grant = value;
    },
    setClaims: (value: Record<string, unknown>) => {
      claims = value;
    },
    wrongSignature: () => {
      wrongSignature = true;
    },
    setTokenGate: (value: ReturnType<typeof deferred<Response>>) => {
      tokenGate = value;
    },
    setRefreshGate: (value: ReturnType<typeof deferred<Response>>) => {
      refreshGate = value;
    },
    setRevokeGate: (value: ReturnType<typeof deferred<Response>>) => {
      revokeGate = value;
    },
    setRevokeEndpoint: (value: string) => {
      revokeEndpoint = value;
    },
    setRevokeStatus: (value: number) => {
      revokeStatus = value;
    },
    setStream: (value: () => Response) => {
      streamResponse = value;
    },
  };
}

async function consume(
  client: ChatGPTBrowserClient,
  body = JSON.stringify({ model: 'model-a', input: [] }),
) {
  const response = await client.transport.send({ body });
  let result = '';
  for await (const chunk of response.body) result += chunk;
  return result;
}

describe('browser-only ChatGPT local prototype', () => {
  it.each(['https://example.test', 'http://localhost:4174', 'https://127.0.0.1:4174'])(
    'rejects unsupported origin %s with local instructions',
    async (origin) => {
      const h = harness(origin);
      expect(h.client.getStatus()).toMatchObject({
        supported: false,
        authenticated: false,
        planEnabled: false,
      });
      expect(h.client.getStatus()).toMatchObject({ unsupportedReason: 'origin-not-loopback' });
      expect(h.client.getStatus().notice).toContain(LOCAL_URL);
      await expect(h.client.signIn()).rejects.toMatchObject({
        kind: 'unsupported-environment',
        message: expect.stringContaining('127.0.0.1') as string,
      });
      expect(h.open).not.toHaveBeenCalled();
    },
  );

  it('opens the popup synchronously, uses fresh PKCE, verifies signed identity, and only persists registration metadata', async () => {
    const h = harness();
    const pending = h.client.signIn();
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.popups[0]?.location.replace).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.popups[0]?.location.replace).toHaveBeenCalledOnce());
    const url = h.authorization();
    expect(url.origin + url.pathname).toBe(`${AUTH}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Loom.js',
      response_type: 'code',
      redirect_uri: `${ORIGIN}/auth/callback`,
      scope: SCOPE,
      resource: RESOURCE,
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    h.message(h.callbackUrl());
    await pending;
    const tokenCall = h.fetchMock.mock.calls.find(([endpoint]) => endpoint === TOKEN);
    const form = tokenCall?.[1]?.body as URLSearchParams;
    expect(Object.fromEntries(form)).toMatchObject({
      client_id: CLIENT,
      code: 'authorization-code-secret',
      redirect_uri: `${ORIGIN}/auth/callback`,
      resource: RESOURCE,
    });
    expect(form.has('client_secret')).toBe(false);
    const challenge = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(form.get('code_verifier') ?? ''),
      ),
    ).toString('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(h.client.getStatus()).toMatchObject({
      authenticated: true,
      planEnabled: true,
      activeAccountId: CLIENT,
    });
    expect(h.client.getStatus().accountLabel).toContain('alice@example.test');
    expect(await h.client.listModels()).toEqual([
      { slug: 'model-b', displayName: 'Model B' },
      { slug: 'model-a', displayName: 'Model A' },
    ]);
    const saved = JSON.stringify([...h.storage]);
    for (const secret of [
      'access-secret',
      'refresh-secret',
      'authorization-code-secret',
      form.get('code_verifier'),
      url.searchParams.get('state'),
      url.searchParams.get('nonce'),
      'id_token',
    ]) {
      expect(saved).not.toContain(secret);
      expect(JSON.stringify(h.client)).not.toContain(secret);
    }
    expect(saved).toContain('verified-subject');
    const reloaded = h.create();
    expect(reloaded.getStatus()).toMatchObject({
      authenticated: false,
      planEnabled: false,
      accounts: h.client.getStatus().accounts,
    });
    expect(
      h.fetchMock.mock.calls.every(
        ([, init]) =>
          init?.credentials === 'omit' && init.redirect === 'error' && init.cache === 'no-store',
      ),
    ).toBe(true);
  });

  it.each([
    ['nonce', { nonce: 'wrong' }],
    ['issuer', { iss: 'https://evil.test' }],
    ['audience', { aud: 'oaiapp_other' }],
    ['expiry', { exp: 1 }],
    ['subject', { sub: '' }],
    ['issued-at', { iat: undefined }],
    ['authorized-party', { aud: [CLIENT, 'other'], azp: 'other' }],
  ] as const)('rejects a genuinely signed token with invalid %s', async (_name, claims) => {
    const h = harness();
    h.setClaims(claims);
    await expect(h.login()).rejects.toThrow('identity could not be verified');
    expect(h.client.getStatus().authenticated).toBe(false);
    await expect(h.client.listModels()).rejects.toThrow('Sign in');
  });
  it('rejects a signature from an unpublished key', async () => {
    const h = harness();
    h.wrongSignature();
    await expect(h.login()).rejects.toThrow('identity could not be verified');
  });
  it('ignores forged sources/origins, consumes the correct callback once, and ignores replay', async () => {
    const h = harness();
    const pending = await h.start();
    const url = h.callbackUrl();
    h.message(url, { origin: 'https://evil.test' });
    h.message(url, { source: {} });
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.message(url);
    h.message(url);
    await pending.promise;
    h.message(url);
    expect(h.fetchMock.mock.calls.filter(([endpoint]) => endpoint === TOKEN)).toHaveLength(1);
  });
  it.each([
    ['state', (url: URL) => url.searchParams.set('state', 'wrong')],
    [
      'path',
      (url: URL) => {
        url.pathname = '/callback';
      },
    ],
    [
      'URL origin',
      (url: URL) => {
        url.hostname = 'localhost';
      },
    ],
    ['duplicate state', (url: URL) => url.searchParams.append('state', 'wrong')],
    ['missing client', (url: URL) => url.searchParams.delete('client_id')],
    ['dynamic client', (url: URL) => url.searchParams.set('client_id', 'dynamic_agent_client')],
    ['denied', (url: URL) => url.searchParams.set('error', 'secret-provider-error')],
    [
      'fragment',
      (url: URL) => {
        url.hash = 'access_token=secret';
      },
    ],
  ] as const)('rejects invalid callback %s before token exchange', async (_label, mutate) => {
    const h = harness();
    const pending = await h.start();
    const url = new URL(h.callbackUrl());
    mutate(url);
    h.message(url.href);
    await expect(pending.promise).rejects.toThrow();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it('keeps the active session when returning sign-in gives a different identity, and uses saved registration/host IDs', async () => {
    const h = harness();
    await h.login();
    const original = h.authorization();
    h.setClaims({ sub: 'different-subject' });
    const returning = await h.start(CLIENT);
    expect(returning.url.searchParams.get('client_id')).toBe(CLIENT);
    expect(returning.url.searchParams.has('agent_name_hint')).toBe(false);
    expect(returning.url.searchParams.get('ext_agent_host_id')).toBe(
      original.searchParams.get('ext_agent_host_id'),
    );
    expect(returning.url.searchParams.get('nonce')).not.toBe(original.searchParams.get('nonce'));
    expect(returning.url.searchParams.get('state')).not.toBe(original.searchParams.get('state'));
    const callback = new URL(h.callbackUrl());
    callback.searchParams.delete('client_id');
    h.message(callback.href);
    await expect(returning.promise).rejects.toThrow('different identity');
    expect(h.client.getStatus().authenticated).toBe(true);
    expect(await h.client.listModels()).toHaveLength(2);
  });
  it('rejects changed returning IDs and reused new IDs without overwriting active credentials', async () => {
    const h = harness();
    await h.login();
    const returning = await h.start(CLIENT);
    h.message(h.callbackUrl({ client_id: 'oaiapp_wrong' }));
    await expect(returning.promise).rejects.toThrow('mismatched');
    const fresh = await h.start();
    h.message(h.callbackUrl());
    await expect(fresh.promise).rejects.toThrow('mismatched');
    expect(h.client.getStatus().activeAccountId).toBe(CLIENT);
    expect(h.fetchMock.mock.calls.filter(([endpoint]) => endpoint === TOKEN)).toHaveLength(1);
  });
  it('retains a newly issued registration after exchange failure so retry does not register again', async () => {
    const h = harness();
    const gate = deferred<Response>();
    h.setTokenGate(gate);
    const pending = await h.start();
    h.message(h.callbackUrl());
    gate.resolve(json({ error: 'invalid_grant', error_description: 'secret' }, 400));
    await expect(pending.promise).rejects.toThrow('token exchange failed');
    expect(h.client.getStatus().accounts.map((item) => item.id)).toEqual([CLIENT]);
    const returning = await h.start(CLIENT);
    expect(returning.url.searchParams.get('client_id')).toBe(CLIENT);
    h.client.cancelSignIn();
    await expect(returning.promise).rejects.toThrow('cancelled');
  });
  it('requires the token grant scope, regardless of callback scope', async () => {
    const h = harness();
    h.setGrant({ scope: 'openid profile email' });
    await h.login();
    expect(h.client.getStatus()).toMatchObject({ authenticated: true, planEnabled: false });
    await expect(h.client.listModels()).rejects.toThrow('not granted plan usage');
    await expect(consume(h.client)).rejects.toThrow('not granted plan usage');
    expect(h.fetchMock.mock.calls.some(([endpoint]) => endpoint.startsWith(RESOURCE))).toBe(false);
  });
  it('reauthorizes a saved account with documented hints and no undocumented prompt', async () => {
    const h = harness();
    h.setGrant({ scope: 'openid profile email' });
    await h.login();
    expect(h.client.getStatus().notice).toContain('plan usage was not granted');
    const firstNonce = h.authorization().searchParams.get('nonce');
    const pending = await h.start(CLIENT);
    expect(pending.url.searchParams.get('scope')).toBe(SCOPE);
    expect(pending.url.searchParams.has('prompt')).toBe(false);
    expect(pending.url.searchParams.has('agent_name_hint')).toBe(false);
    // The in-memory ID token identifies the active account; it is never persisted.
    const hint = pending.url.searchParams.get('id_token_hint') ?? '';
    const claims = JSON.parse(
      Buffer.from(hint.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: 'verified-subject', nonce: firstNonce, aud: CLIENT });
    expect(pending.url.searchParams.has('login_hint')).toBe(false);
    expect(JSON.stringify([...h.storage])).not.toContain(hint);
    h.setGrant({});
    h.message(h.callbackUrl());
    await pending.promise;
    expect(h.client.getStatus().planEnabled).toBe(true);
    await h.client.signOut();
    const afterSignOut = await h.start(CLIENT);
    expect(afterSignOut.url.searchParams.has('id_token_hint')).toBe(false);
    expect(afterSignOut.url.searchParams.get('login_hint')).toBe('alice@example.test');
    h.client.cancelSignIn();
    await expect(afterSignOut.promise).rejects.toThrow('cancelled');
  });
  it('handles blocked popups without opening network requests', async () => {
    const h = harness();
    h.open.mockReturnValueOnce(null as never);
    await expect(h.client.signIn()).rejects.toThrow('popup was blocked');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it('cancels before asynchronous PKCE preparation can navigate the popup', async () => {
    const h = harness();
    const pending = h.client.signIn();
    h.client.cancelSignIn();
    await expect(pending).rejects.toThrow('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.popups[0]?.location.replace).not.toHaveBeenCalled();
    expect(h.popups[0]?.closed).toBe(true);
  });
  it.each(['close', 'timeout', 'expired-message'] as const)('rejects %s attempts', async (mode) => {
    const h = harness();
    const pending = await h.start();
    vi.useFakeTimers();
    if (mode === 'close') {
      const popup = h.popups[0];
      if (popup === undefined) throw new Error('Missing popup');
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(301);
      // The poll was created using real timers; use a real wait for the close branch.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 320));
    } else if (mode === 'expired-message') {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      h.message(h.callbackUrl());
    } else {
      // Expiry is checked again on callback even when a background tab's timer was throttled.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      h.message(h.callbackUrl());
    }
    await expect(pending.promise).rejects.toThrow(/closed|expired|timed out/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it('never activates a late token exchange after logout, even if fetch ignores abort', async () => {
    const h = harness();
    const gate = deferred<Response>();
    h.setTokenGate(gate);
    const pending = await h.start();
    h.message(h.callbackUrl());
    await h.client.signOut();
    await expect(pending.promise).rejects.toThrow('cancelled');
    gate.resolve(
      json({
        access_token: 'late-secret',
        refresh_token: 'late-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: SCOPE,
        id_token: await h.sign(pending.url.searchParams.get('nonce') ?? ''),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.client.getStatus().authenticated).toBe(false);
    expect(h.fetchMock.mock.calls.filter(([url]) => url.includes('jwks'))).toHaveLength(0);
  });
  it('serializes refresh and rotates tokens atomically with the same issued client and resource', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    const gate = deferred<Response>();
    h.setRefreshGate(gate);
    const first = h.client.listModels();
    const second = h.client.listModels();
    await vi.waitFor(() =>
      expect(h.fetchMock.mock.calls.filter(([url]) => url === TOKEN)).toHaveLength(2),
    );
    gate.resolve(
      json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    await Promise.all([first, second]);
    const refreshForm = h.fetchMock.mock.calls.filter(([url]) => url === TOKEN)[1]?.[1]
      ?.body as URLSearchParams;
    expect(Object.fromEntries(refreshForm)).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: 'refresh-secret',
      resource: RESOURCE,
    });
    const catalogs = h.fetchMock.mock.calls.filter(([url]) => url === `${RESOURCE}/models`);
    expect(catalogs).toHaveLength(2);
    expect(
      catalogs.every(
        ([, init]) =>
          (init?.headers as Record<string, string>).Authorization === 'Bearer new-access',
      ),
    ).toBe(true);
    expect(JSON.stringify([...h.storage])).not.toContain('new-refresh');
    expect(await h.client.signOut()).toEqual({ revoked: true });
    const revocation = h.fetchMock.mock.calls.find(([url]) => url === `${AUTH}/oauth/revoke`)?.[1]
      ?.body as URLSearchParams;
    expect(revocation.get('token')).toBe('new-refresh');
    expect(h.client.getStatus()).toMatchObject({
      authenticated: false,
      accounts: [{ id: CLIENT, label: expect.any(String) }],
    });
  });
  it.each([429, 500, 503])(
    'retains credentials after HTTP %s refresh errors, even if the body says invalid_grant',
    async (status) => {
      const h = harness();
      h.setGrant({ expires_in: 1 });
      await h.login();
      h.fetchMock.mockImplementationOnce(async () =>
        json({ error: 'invalid_grant', error_description: 'refresh-secret' }, status),
      );
      const error = await h.client.listModels().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ChatGPTBrowserError);
      expect(error).toMatchObject({
        status,
        invalidatesSession: false,
        tokenErrorCode: 'invalid_grant',
      });
      expect(String(error)).toContain('retry shortly');
      expect(String(error)).not.toContain('refresh-secret');
      expect(h.client.getStatus()).toMatchObject({ authenticated: true, activeAccountId: CLIENT });
      expect(await h.client.listModels()).toHaveLength(2);
      const refreshCalls = h.fetchMock.mock.calls.filter(([url]) => url === TOKEN).slice(1);
      expect(refreshCalls).toHaveLength(2);
      expect(
        refreshCalls.every(
          ([, init]) => (init?.body as URLSearchParams).get('refresh_token') === 'refresh-secret',
        ),
      ).toBe(true);
    },
  );
  it('retains tokens after a refresh network failure and exposes only the safe error class', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    h.fetchMock.mockRejectedValueOnce(new Error('access-secret refresh-secret raw network trace'));
    const error = await h.client.listModels().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChatGPTBrowserError);
    expect(String(error)).toContain('retry');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(h.client.getStatus().authenticated).toBe(true);
    expect(await h.client.listModels()).toHaveLength(2);
  });
  it.each([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ])(
    'clears only confirmed unusable refresh grant %s and retains registration',
    async (errorCode) => {
      const h = harness();
      h.setGrant({ expires_in: 1 });
      await h.login();
      h.fetchMock.mockImplementationOnce(async () =>
        json({ error: errorCode, error_description: 'secret' }, 400),
      );
      const error = await h.client.listModels().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ChatGPTBrowserError);
      expect(error).toMatchObject({ tokenErrorCode: errorCode, invalidatesSession: true });
      expect(h.client.getStatus()).toMatchObject({
        authenticated: false,
        accounts: [{ id: CLIENT, label: expect.any(String) }],
      });
      await expect(h.client.listModels()).rejects.toThrow('Sign in');
    },
  );
  it('keeps a session for invalid_client and unknown refresh errors with bounded sanitized classification', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    h.fetchMock.mockImplementationOnce(async () => json({ error: 'invalid_client' }, 400));
    const configuration = await h.client.listModels().catch((value: unknown) => value);
    expect(configuration).toMatchObject({
      tokenErrorCode: 'invalid_client',
      invalidatesSession: false,
    });
    expect(String(configuration)).toContain('configuration');
    expect(h.client.getStatus().authenticated).toBe(true);
    h.fetchMock.mockImplementationOnce(async () =>
      json({ error: 'secret-not-allowlisted', error_description: 'secret' }, 400),
    );
    const unknown = await h.client.listModels().catch((value: unknown) => value);
    expect(unknown).toMatchObject({ tokenErrorCode: undefined, invalidatesSession: false });
    expect(String(unknown)).not.toContain('secret');
    expect(h.client.getStatus().authenticated).toBe(true);
    h.fetchMock.mockImplementationOnce(async () =>
      json({ error: 'invalid_grant', padding: 'x'.repeat(20_000) }, 400),
    );
    const oversized = await h.client.listModels().catch((value: unknown) => value);
    expect(oversized).toMatchObject({ tokenErrorCode: undefined, invalidatesSession: false });
    expect(h.client.getStatus().authenticated).toBe(true);
  });
  it('clears credentials when refresh returns a signed different identity', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    const id = await h.sign(h.authorization().searchParams.get('nonce') ?? '', CLIENT, {
      sub: 'wrong-subject',
    });
    h.fetchMock.mockImplementationOnce(async () =>
      json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: id,
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    await expect(h.client.listModels()).rejects.toThrow('different account identity');
    expect(h.client.getStatus().authenticated).toBe(false);
  });
  it('cancels a caller waiting for shared refresh without cancelling other consumers', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    const gate = deferred<Response>();
    h.setRefreshGate(gate);
    const cancellation = createCancellationSource();
    const response = h.client.transport.send({
      body: JSON.stringify({ model: 'm', input: [] }),
      signal: cancellation.signal,
    });
    const catalog = h.client.listModels();
    cancellation.cancel();
    await expect(response).rejects.toThrow('cancelled');
    gate.resolve(
      json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    expect(await catalog).toHaveLength(2);
    expect(h.fetchMock.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(0);
  });
  it('does not restore a session after a refresh races logout', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    const gate = deferred<Response>();
    h.setRefreshGate(gate);
    const catalog = h.client.listModels();
    void catalog.catch(() => undefined);
    await vi.waitFor(() =>
      expect(h.fetchMock.mock.calls.filter(([url]) => url === TOKEN)).toHaveLength(2),
    );
    const logout = h.client.signOut();
    gate.resolve(
      json({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    await expect(catalog).rejects.toThrow('could not be refreshed');
    expect(await logout).toEqual({ revoked: false });
    expect(h.client.getStatus()).toMatchObject({ authenticated: false, planEnabled: false });
    expect(h.client.getStatus().notice).toContain('not confirmed');
  });
  it.each([
    'https://evil.test/revoke',
    'https://auth.openai.com.evil.test/revoke',
    `${AUTH}/revoke?token=secret`,
  ])('refuses untrusted revocation endpoint %s but clears locally', async (endpoint) => {
    const h = harness();
    await h.login();
    h.setRevokeEndpoint(endpoint);
    expect(await h.client.signOut()).toEqual({ revoked: false });
    expect(h.client.getStatus().authenticated).toBe(false);
    expect(h.client.getStatus().notice).toContain('Remote revocation was not confirmed');
    expect(h.fetchMock.mock.calls.some(([url]) => url === endpoint)).toBe(false);
  });
  it('keeps a new sign-in active when an older logout finishes', async () => {
    const h = harness();
    await h.login();
    const gate = deferred<Response>();
    h.setRevokeGate(gate);
    const logout = h.client.signOut();
    await h.login(CLIENT);
    gate.resolve(new Response(null, { status: 503 }));
    await logout;
    expect(h.client.getStatus()).toMatchObject({ authenticated: true, activeAccountId: CLIENT });
    expect(h.client.getStatus().notice).not.toContain('Signed out locally');
  });
  it('sanitizes provider error bodies and thrown network exceptions', async () => {
    const h = harness();
    const gate = deferred<Response>();
    h.setTokenGate(gate);
    const pending = await h.start();
    h.message(h.callbackUrl());
    gate.resolve(
      json({ error: 'secret-access-token', error_description: 'secret-refresh-token' }, 400),
    );
    await expect(pending.promise).rejects.toThrow('HTTP 400');
    const error = await pending.promise.catch((value: unknown) => value);
    expect(String(error)).not.toContain('secret-access-token');
    expect(JSON.stringify(error)).not.toContain('secret-refresh-token');
  });
  it('disposes active requests and pending popups without leaving message listeners', async () => {
    const h = harness();
    const pending = await h.start();
    h.client.dispose();
    await expect(pending.promise).rejects.toThrow('cancelled');
    expect(h.listeners.size).toBe(0);
    expect(h.client.getStatus()).toMatchObject({ authenticated: false, supported: false });
  });
});

describe('ChatGPT direct Responses transport', () => {
  it('forces public endpoint, store:false, stream:true, array context, and namespace tools', async () => {
    const h = harness();
    await h.login();
    h.setStream(() =>
      sse(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            name: 'loom.file_read',
            namespace: 'loom',
            call_id: 'call-1',
            arguments: '{}',
          },
        },
        completed,
      ),
    );
    const stream = await consume(
      h.client,
      JSON.stringify({
        model: 'model-a',
        input: [
          { type: 'message', role: 'system', content: 'Instructions' },
          { type: 'function_call', name: 'file_read', call_id: 'old', arguments: '{}' },
        ],
        tools: [{ type: 'function', name: 'file_read', parameters: { type: 'object' } }],
        store: true,
        stream: false,
        temperature: 1,
        max_output_tokens: 100,
        previous_response_id: 'old',
        endpoint: 'https://evil.test',
      }),
    );
    const request = h.fetchMock.mock.calls.find(([url]) => url === `${RESOURCE}/responses`)?.[1];
    const body = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'model-a',
      store: false,
      stream: true,
      tools: [
        { type: 'namespace', name: 'loom', tools: [{ type: 'function', name: 'file_read' }] },
      ],
      input: [{ role: 'developer' }, { namespace: 'loom' }],
    });
    for (const unsupported of [
      'temperature',
      'max_output_tokens',
      'previous_response_id',
      'endpoint',
    ])
      expect(body).not.toHaveProperty(unsupported);
    expect(stream).toContain('"name":"file_read"');
    expect(stream).not.toContain('"namespace"');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer access-secret' });
  });
  it('works through the real compatible decoder and restores Loom operation aliases', async () => {
    const h = harness();
    await h.login();
    h.setStream(() => {
      const call = h.fetchMock.mock.calls.find(([url]) => url.endsWith('/responses'));
      const body = JSON.parse(call?.[1]?.body as string) as {
        tools: { tools: { name: string }[] }[];
      };
      const name = body.tools[0]?.tools[0]?.name;
      if (name === undefined) throw new Error('Missing tool');
      return sse({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: `loom.${name}`,
              namespace: 'loom',
              call_id: 'call-1',
              arguments: '{"path":"a.txt"}',
            },
          ],
        },
      });
    });
    const model = createOpenAICompatibleResponsesModel({
      model: 'model-a',
      transport: h.client.transport,
    });
    const events = [];
    for await (const event of model.generate({
      instructions: '',
      messages: [{ role: 'user', content: 'Read a.txt' }],
      tools: [
        {
          operation: 'workspace.read_file',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    }))
      events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call',
        call: expect.objectContaining({ operation: 'workspace.read_file' }),
      }),
    );
  });
  it.each([
    ['DONE without completion', () => sse('[DONE]'), 'without response.completed'],
    [
      'interrupted',
      () => sse({ type: 'response.output_text.delta', delta: 'partial' }),
      'without response.completed',
    ],
    [
      'incomplete',
      () => sse({ type: 'response.incomplete', response: { status: 'incomplete' } }),
      'incomplete',
    ],
    [
      'failure',
      () => sse({ type: 'response.failed', response: { error: { message: 'provider-secret' } } }),
      'failure',
    ],
    [
      'usage limit',
      () =>
        sse({
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'secret' },
          },
        }),
      /usage limit reached/i,
    ],
    [
      'usage unavailable',
      () =>
        sse({ type: 'error', code: 'subscription_sharing_usage_unavailable', message: 'secret' }),
      'unavailable',
    ],
    [
      'invalid completion',
      () => sse({ type: 'response.completed', response: { status: 'failed' } }),
      'invalid completion',
    ],
    ['JSON instead of SSE', () => json({ status: 'completed' }), 'did not return a stream'],
  ] as const)('rejects %s without generation replay', async (_name, stream, error) => {
    const h = harness();
    await h.login();
    h.setStream(stream);
    await expect(consume(h.client)).rejects.toThrow(error);
    expect(h.fetchMock.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(1);
  });
  it('rejects malformed input without issuing inference', async () => {
    const h = harness();
    await h.login();
    await expect(consume(h.client, JSON.stringify({ model: 'm', input: 'text' }))).rejects.toThrow(
      'input array',
    );
    expect(h.fetchMock.mock.calls.filter(([url]) => url.endsWith('/responses'))).toHaveLength(0);
  });
  it('cancellation aborts the HTTP request and streamed read', async () => {
    const h = harness();
    await h.login();
    h.setStream(() => {
      const init = h.fetchMock.mock.calls.find(([url]) => url.endsWith('/responses'))?.[1];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new Error('secret-network-error')),
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const source = createCancellationSource();
    const response = await h.client.transport.send({
      body: JSON.stringify({ model: 'model-a', input: [] }),
      signal: source.signal,
    });
    const reading = (async () => {
      for await (const chunk of response.body) {
        expect(typeof chunk).toBe('string');
      }
    })();
    source.cancel();
    await expect(reading).rejects.toThrow('cancelled');
    const init = h.fetchMock.mock.calls.find(([url]) => url.endsWith('/responses'))?.[1];
    expect(init?.signal?.aborted).toBe(true);
  });
});

describe('ChatGPT browser client options', () => {
  it('uses the configured app name, callback path, message type, storage, and key prefix', async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => saved.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void saved.set(key, value)),
    };
    const h = harness(ORIGIN, {
      appName: 'Generic Host',
      callbackPath: '/oauth/chatgpt',
      messageType: 'host/chatgpt',
      storage,
      storageKeyPrefix: 'host.ai.',
    });
    const pending = await h.start();
    expect(Object.fromEntries(pending.url.searchParams)).toMatchObject({
      agent_name_hint: 'Generic Host',
      redirect_uri: `${ORIGIN}/oauth/chatgpt`,
    });
    const url = new URL(`${ORIGIN}/oauth/chatgpt`);
    url.search = new URLSearchParams({
      state: pending.url.searchParams.get('state') ?? '',
      code: 'authorization-code-secret',
      client_id: CLIENT,
    }).toString();
    const dispatch = (type: string) =>
      h.listeners.forEach((listener) =>
        listener({
          origin: ORIGIN,
          source: h.popups.at(-1),
          data: { type, url: url.href },
        } as unknown as MessageEvent),
      );
    dispatch(CALLBACK);
    expect(h.fetchMock).not.toHaveBeenCalled();
    dispatch('host/chatgpt');
    await pending.promise;
    expect(h.client.getStatus().authenticated).toBe(true);
    expect([...saved.keys()].sort()).toEqual(['host.ai.host.v1', 'host.ai.registrations.v1']);
    expect(h.storage.size).toBe(0);
    expect(JSON.stringify([...saved])).not.toMatch(/secret/u);
  });

  it('keeps metadata in memory when storage is null', async () => {
    const h = harness(ORIGIN, { storage: null });
    await h.login();
    expect(h.storage.size).toBe(0);
    expect(h.client.getStatus().accounts).toEqual([
      {
        id: CLIENT,
        label: expect.stringContaining('alice@example.test') as string,
        verified: true,
      },
    ]);
  });

  it('reports storage failures as a typed error without exposing the storage error', async () => {
    const h = harness(ORIGIN, {
      storage: {
        getItem: () => {
          throw new Error('storage-secret');
        },
        setItem: () => {
          throw new Error('storage-secret');
        },
      },
    });
    const error = await h.client.signIn().catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'storage-unavailable' });
    expect(String(error)).not.toContain('storage-secret');
  });

  it('uses only the injected fetch and clock', async () => {
    let clock = Date.parse('2026-11-20T10:00:00Z');
    const injected = vi.fn((url: string, init: RequestInit): Promise<Response> =>
      Promise.reject(new Error(`unused ${url} ${String(init.method)}`)),
    );
    const h = harness(ORIGIN, { fetch: injected, now: () => clock });
    injected.mockImplementation((url: string, init: RequestInit) => h.fetchMock(url, init));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const global = vi.fn(() => Promise.reject(new Error('global fetch used')));
    vi.stubGlobal('fetch', global);
    await h.login();
    expect(global).not.toHaveBeenCalled();
    const before = h.fetchMock.mock.calls.filter(([url]) => url === TOKEN).length;
    await h.client.listModels();
    expect(h.fetchMock.mock.calls.filter(([url]) => url === TOKEN)).toHaveLength(before);
    clock += 3600 * 1000;
    vi.setSystemTime(clock);
    await h.client.listModels();
    expect(h.fetchMock.mock.calls.filter(([url]) => url === TOKEN)).toHaveLength(before + 1);
  });

  it.each([
    [{ appName: '' }],
    [{ appName: 'App', callbackPath: 'auth/callback' }],
    [{ appName: 'App', callbackPath: '/auth/../callback' }],
    [{ appName: 'App', callbackPath: '/auth?x=1' }],
    [{ appName: 'App', messageType: '' }],
    [{ appName: 'App', toolNamespace: { name: 'has space' } }],
    [{ appName: 'App', signInTimeoutMs: 0 }],
    [{ appName: 'App', requestTimeoutMs: Number.NaN }],
    [{ appName: 'App', storageKeyPrefix: 'x'.repeat(201) }],
  ] as const)('rejects invalid options %j', (options) => {
    harness();
    expect(() =>
      createChatGPTBrowserClient(options as unknown as ChatGPTBrowserClientOptions),
    ).toThrow(TypeError);
  });

  it('publishes cached status snapshots to subscribers', async () => {
    const h = harness();
    const seen: unknown[] = [];
    const failing = vi.fn(() => {
      throw new Error('observer failure');
    });
    const unsubscribe = h.client.subscribe((status) => seen.push(status));
    h.client.subscribe(failing);
    const first = h.client.getStatus();
    expect(h.client.getStatus()).toBe(first);
    expect(first).toMatchObject({ signingIn: false, authenticated: false });
    await h.login();
    expect(seen.some((status) => (status as { signingIn: boolean }).signingIn)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ authenticated: true, signingIn: false });
    expect(h.client.getStatus()).not.toBe(first);
    expect(failing).toHaveBeenCalled();
    unsubscribe();
    const count = seen.length;
    await h.client.signOut();
    expect(seen).toHaveLength(count);
    expect(() => h.client.subscribe(undefined as never)).toThrow(TypeError);
  });

  it('reports disposal as an unsupported reason', () => {
    const h = harness();
    const listener = vi.fn();
    h.client.subscribe(listener);
    h.client.dispose();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ supported: false, unsupportedReason: 'disposed' }),
    );
    h.client.dispose();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('ChatGPT browser error mapping', () => {
  const failingResponse = (status: number, body: unknown, requestId = 'req_abc-123') =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });

  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'usage-limit-reached', false],
    [403, 'subscription_sharing_user_not_eligible', 'user-not-eligible', false],
    [503, 'subscription_sharing_usage_unavailable', 'temporarily-unavailable', true],
    [503, 'subscription_sharing_user_unavailable', 'temporarily-unavailable', true],
    [400, 'subscription_sharing_unsupported_capability', 'unsupported-capability', false],
    [403, 'subscription_sharing_route_not_supported', 'client-configuration', false],
    [401, 'subscription_sharing_invalid_user', 'credential-rejected', false],
    [403, 'chatpass_v2_scope_not_authorized', 'client-configuration', false],
    [403, 'chatpass_v2_invalid_authorization_context', 'client-configuration', false],
  ] as const)('maps HTTP %i %s to %s', async (status, code, kind, retryable) => {
    const h = harness();
    await h.login();
    h.setStream(() =>
      failingResponse(status, {
        error: { code, message: 'provider-secret', param: 'tools[0]' },
      }),
    );
    const error = await consume(h.client).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChatGPTBrowserError);
    expect(error).toMatchObject({
      kind,
      providerCode: code,
      status,
      retryable,
      requestId: 'req_abc-123',
      invalidatesSession: false,
    });
    expect(JSON.stringify(error)).not.toContain('provider-secret');
    expect(String(error)).not.toContain('provider-secret');
    expect(h.client.getStatus().authenticated).toBe(true);
  });

  it.each([
    [401, 'credential-rejected'],
    [403, 'access-denied'],
    [429, 'temporarily-unavailable'],
    [500, 'temporarily-unavailable'],
    [503, 'temporarily-unavailable'],
    [400, 'request-failed'],
  ] as const)('maps uncoded admission HTTP %i to %s', async (status, kind) => {
    const h = harness();
    await h.login();
    h.setStream(() =>
      failingResponse(
        status,
        { detail: 'diagnostic-secret', error: { code: 'secret_code' } },
        'bad id!',
      ),
    );
    const error = await consume(h.client).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind, status, providerCode: undefined, requestId: undefined });
    expect(JSON.stringify(error)).not.toMatch(/secret/u);
  });

  it('classifies non-JSON and oversized error bodies without reading them into errors', async () => {
    const h = harness();
    await h.login();
    h.setStream(() => failingResponse(429, 'x'.repeat(40_000)));
    await expect(consume(h.client)).rejects.toMatchObject({ kind: 'temporarily-unavailable' });
  });

  it('maps model catalog failures with the same allowlist', async () => {
    const h = harness();
    await h.login();
    h.fetchMock.mockImplementationOnce(async () =>
      failingResponse(403, { error: { code: 'subscription_sharing_user_not_eligible' } }),
    );
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'user-not-eligible' });
    h.fetchMock.mockImplementationOnce(async () => failingResponse(200, '[]'));
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
    h.fetchMock.mockImplementationOnce(async () => failingResponse(200, { models: 'x' }));
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
    h.fetchMock.mockRejectedValueOnce(new Error('network-secret'));
    const network = await h.client.listModels().catch((value: unknown) => value);
    expect(network).toMatchObject({ kind: 'temporarily-unavailable', retryable: true });
    expect(JSON.stringify(network)).not.toContain('network-secret');
  });

  it.each([
    [
      {
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_user_not_eligible' } },
      },
      'user-not-eligible',
    ],
    [
      { type: 'error', error: { code: 'subscription_sharing_unsupported_capability' } },
      'unsupported-capability',
    ],
    [{ type: 'error', code: 'subscription_sharing_user_unavailable' }, 'temporarily-unavailable'],
    [{ type: 'error', code: 'secret-unknown-code' }, 'request-failed'],
  ] as const)('maps in-stream failure %j to %s', async (event, kind) => {
    const h = harness();
    await h.login();
    h.setStream(() => sse(event));
    const error = await consume(h.client).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind });
    expect(JSON.stringify(error)).not.toContain('secret-unknown-code');
  });

  it('maps missing sessions and plan grants to typed kinds', async () => {
    const h = harness();
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'not-signed-in' });
    h.setGrant({ scope: 'openid profile email' });
    await h.login();
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'plan-not-granted' });
    expect(h.client.getStatus().notice).toContain('not granted');
  });

  it('marks terminal refresh failures as reauthentication-required', async () => {
    const h = harness();
    h.setGrant({ expires_in: 1 });
    await h.login();
    h.fetchMock.mockImplementationOnce(async () => json({ error: 'refresh_token_reused' }, 400));
    await expect(h.client.listModels()).rejects.toMatchObject({
      kind: 'reauthentication-required',
      invalidatesSession: true,
      retryable: false,
    });
    h.setGrant({ expires_in: 1 });
    await h.login(CLIENT);
    h.fetchMock.mockImplementationOnce(async () => json({ error: 'invalid_client' }, 401));
    await expect(h.client.listModels()).rejects.toMatchObject({ kind: 'client-configuration' });
  });
});
