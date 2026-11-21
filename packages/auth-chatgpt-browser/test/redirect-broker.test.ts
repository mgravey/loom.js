import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  createChatGPTBrowserClient,
  detectChatGPTBrowserSupport,
  type ChatGPTBrowserClient,
  type ChatGPTBrowserRedirectBroker,
  type ChatGPTBrowserRedirectRequest,
  type ChatGPTBrowserRedirectResult,
} from '../src/index.js';

const SITE = 'https://app.example.test';
const AUTH = 'https://auth.openai.com';
const REDIRECT = 'http://127.0.0.1:1456/auth/callback';
const CLIENT = 'oaiapp_broker_test';
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface PendingAuthorization {
  readonly request: ChatGPTBrowserRedirectRequest;
  resolve(result: ChatGPTBrowserRedirectResult): void;
  reject(error: unknown): void;
}

function harness(origin = SITE) {
  const open = vi.fn();
  const listeners = new Set<(event: MessageEvent) => void>();
  vi.stubGlobal('window', {
    location: new URL(`${origin}/app`),
    open,
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  });
  const pending: PendingAuthorization[] = [];
  const broker: ChatGPTBrowserRedirectBroker = {
    redirectUri: REDIRECT,
    authorize: vi.fn(
      (request: ChatGPTBrowserRedirectRequest) =>
        new Promise<ChatGPTBrowserRedirectResult>((resolve, reject) => {
          pending.push({ request, resolve, reject });
        }),
    ),
  };
  const forms: URLSearchParams[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === `${AUTH}/.well-known/openid-configuration`)
      return json({ issuer: AUTH, jwks_uri: `${AUTH}/.well-known/jwks.json` });
    if (url === `${AUTH}/.well-known/jwks.json`) return json(jwks);
    if (url === `${AUTH}/api/accounts/oauth/token`) {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      forms.push(form);
      const authorization = new URL(pending.at(-1)?.request.authorizationUrl ?? '');
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        iss: AUTH,
        sub: 'subject',
        aud: CLIENT,
        iat: now,
        exp: now + 3600,
        nonce: authorization.searchParams.get('nonce'),
        email: 'user@example.test',
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
        .sign(keys.privateKey);
      return json({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: idToken,
        scope: SCOPE,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    throw new Error('Unexpected endpoint');
  });
  const client = createChatGPTBrowserClient({
    appName: 'Broker test',
    storage: null,
    fetch,
    redirectBroker: broker,
  });
  clients.push(client);
  const started = async () => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const current = pending.at(-1);
    if (current === undefined) throw new Error('No brokered authorization');
    return current;
  };
  const callback = (state: string, fields: Record<string, string> = {}) =>
    `${REDIRECT}?${new URLSearchParams({ code: 'code-secret', state, client_id: CLIENT, ...fields }).toString()}`;
  return { client, broker, open, listeners, pending, fetch, forms, started, callback };
}

describe('ChatGPT redirect broker', () => {
  it('signs in on a non-loopback origin without a page popup and verifies the identity', async () => {
    const h = harness();
    expect(h.client.getStatus()).toMatchObject({ supported: true });
    const signIn = h.client.signIn();
    expect(h.open).not.toHaveBeenCalled();
    const attempt = await h.started();
    const authorization = new URL(attempt.request.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(`${AUTH}/api/accounts/authorize`);
    expect(authorization.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(authorization.searchParams.get('state')).toBe(attempt.request.state);
    expect(attempt.request.signal.aborted).toBe(false);
    attempt.resolve({ status: 'callback', url: h.callback(attempt.request.state) });
    await signIn;
    expect(h.forms[0]?.get('redirect_uri')).toBe(REDIRECT);
    expect(h.client.getStatus()).toMatchObject({
      authenticated: true,
      planEnabled: true,
      accountLabel: `user@example.test (${CLIENT})`,
    });
    expect(attempt.request.signal.aborted).toBe(true);
  });

  it('ignores page postMessage callbacks while a broker owns the attempt', async () => {
    const h = harness();
    const signIn = h.client.signIn();
    void signIn.catch(() => undefined);
    const attempt = await h.started();
    h.listeners.forEach((listener) =>
      listener({
        origin: SITE,
        source: null,
        data: { type: 'loom/chatgpt-browser/callback', url: h.callback(attempt.request.state) },
      } as MessageEvent),
    );
    expect(h.forms).toHaveLength(0);
    h.client.cancelSignIn();
    await expect(signIn).rejects.toMatchObject({ kind: 'sign-in-cancelled' });
    expect(attempt.request.signal.aborted).toBe(true);
  });

  it.each([
    [{ status: 'cancelled' }, 'sign-in-cancelled'],
    [{ status: 'unavailable' }, 'unsupported-environment'],
    [{ status: 'failed' }, 'sign-in-failed'],
    [{ status: 'callback', url: 'not a url' }, 'sign-in-failed'],
    [{ status: 'callback', url: `${REDIRECT}?${'x'.repeat(16_400)}` }, 'sign-in-failed'],
    [{ status: 'unexpected' }, 'sign-in-failed'],
  ] as const)('maps broker result %j to %s without exchanging a code', async (result, kind) => {
    const h = harness();
    const signIn = h.client.signIn();
    const attempt = await h.started();
    attempt.resolve(result as ChatGPTBrowserRedirectResult);
    await expect(signIn).rejects.toMatchObject({ kind });
    expect(h.forms).toHaveLength(0);
  });

  it('sanitizes a throwing broker', async () => {
    const h = harness();
    const signIn = h.client.signIn();
    const attempt = await h.started();
    attempt.reject(new Error('code-secret leaked in broker error'));
    const error = await signIn.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'sign-in-failed' });
    expect(String((error as Error).message)).not.toContain('code-secret');
  });

  it.each([
    ['a different state', (state: string) => `${REDIRECT}?code=c&state=${state}x`],
    [
      'a different port',
      (state: string) => `http://127.0.0.1:1457/auth/callback?code=c&state=${state}`,
    ],
    ['a different path', (state: string) => `http://127.0.0.1:1456/other?code=c&state=${state}`],
    ['the page origin', (state: string) => `${SITE}/auth/callback?code=c&state=${state}`],
  ])('rejects a callback with %s', async (_label, build) => {
    const h = harness();
    const signIn = h.client.signIn();
    const attempt = await h.started();
    attempt.resolve({ status: 'callback', url: build(attempt.request.state) });
    await expect(signIn).rejects.toMatchObject({ kind: 'sign-in-failed' });
    expect(h.forms).toHaveLength(0);
  });

  it('ignores a late broker callback after the attempt timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const h = harness();
    const signIn = h.client.signIn();
    void signIn.catch(() => undefined);
    const attempt = await h.started();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(signIn).rejects.toMatchObject({ kind: 'sign-in-cancelled' });
    expect(attempt.request.signal.aborted).toBe(true);
    attempt.resolve({ status: 'callback', url: h.callback(attempt.request.state) });
    await Promise.resolve();
    expect(h.forms).toHaveLength(0);
    expect(h.client.getStatus().authenticated).toBe(false);
  });

  it.each([
    'http://localhost:1456/auth/callback',
    'https://127.0.0.1:1456/auth/callback',
    'http://127.0.0.1/auth/callback',
    'http://127.0.0.1:1456/auth/callback?x=1',
    'http://127.0.0.1:1456/auth/callback#x',
    'http://user@127.0.0.1:1456/auth/callback',
    'http://127.0.0.1:1456/a/../b',
    'not a url',
  ])('rejects broker redirect URI %s', (redirectUri) => {
    vi.stubGlobal('window', { location: new URL(`${SITE}/`), addEventListener: vi.fn() });
    expect(() =>
      createChatGPTBrowserClient({
        appName: 'Broker test',
        storage: null,
        redirectBroker: { redirectUri, authorize: vi.fn() },
      }),
    ).toThrow(TypeError);
  });

  it('rejects a malformed broker object', () => {
    vi.stubGlobal('window', { location: new URL(`${SITE}/`), addEventListener: vi.fn() });
    expect(() =>
      createChatGPTBrowserClient({
        appName: 'Broker test',
        storage: null,
        redirectBroker: { redirectUri: REDIRECT } as unknown as ChatGPTBrowserRedirectBroker,
      }),
    ).toThrow(TypeError);
  });
});

describe('detectChatGPTBrowserSupport with a redirect broker', () => {
  const crypto = globalThis.crypto;
  it('reports the redirect-broker mode on any origin and keeps the default unchanged', () => {
    const environment = { window: { location: new URL(`${SITE}/`) }, crypto };
    expect(detectChatGPTBrowserSupport(environment)).toEqual({
      supported: false,
      reason: 'origin-not-loopback',
    });
    expect(detectChatGPTBrowserSupport(environment, { redirectBroker: true })).toEqual({
      supported: true,
      mode: 'redirect-broker',
    });
    expect(
      detectChatGPTBrowserSupport(
        { window: { location: new URL(`${SITE}/`) } },
        { redirectBroker: true },
      ),
    ).toEqual({ supported: false, reason: 'web-crypto-unavailable' });
  });
});
