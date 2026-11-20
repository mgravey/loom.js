import { describe, expect, it, vi } from 'vitest';
import type { ChromeStorageArea } from '@mgravey/loom-extension';
import type { CodexChromeExtensionApi, CodexModelFetch } from '../src/chrome-contracts.js';
import {
  createGoogleSubscriptionAuth,
  GOOGLE_SUBSCRIPTION_SCOPE,
  GOOGLE_SUBSCRIPTION_ENDPOINT,
  checkGoogleSubscriptionAccess,
} from '../src/google-subscription.js';
import {
  normalizeResponsesConnection,
  createResponsesConnectionStore,
} from '../src/responses-connections.js';
import { nativeRequest, nativeResponse, serverHeaders } from '../src/server-provider.js';

const profile = normalizeResponsesConnection({
  id: 'subscription',
  label: 'Google account',
  provider: 'gemini-subscription',
  endpoint: GOOGLE_SUBSCRIPTION_ENDPOINT,
  apiKey: '',
  subscriptionModels: ['gemini-test'],
});
function storage() {
  const values: Record<string, unknown> = {};
  const api: ChromeStorageArea = {
    setAccessLevel: vi.fn(async () => undefined),
    get: async (key) => ({ [key]: values[key] }),
    set: async (items) => {
      Object.assign(values, items);
    },
    remove: async (key) => {
      Reflect.deleteProperty(values, key);
    },
  };
  return { api, values };
}
function response(body: unknown, status = 200) {
  return {
    status,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        c.close();
      },
    }),
  };
}
function fixture(configured = true) {
  const session = storage(),
    local = storage();
  const identity = {
    getAuthToken: vi.fn(async () => ({
      token: 'private-google-token',
      grantedScopes: [GOOGLE_SUBSCRIPTION_SCOPE],
    })),
    clearAllCachedAuthTokens: vi.fn(async () => undefined),
  };
  const chrome = {
    runtime: {
      getManifest: () =>
        configured
          ? {
              oauth2: {
                client_id: 'loom-test.apps.googleusercontent.com',
                scopes: [GOOGLE_SUBSCRIPTION_SCOPE],
              },
            }
          : {},
    },
    identity,
    storage: { session: session.api, local: local.api },
  } as unknown as CodexChromeExtensionApi;
  const fetch = vi.fn<CodexModelFetch>(async () =>
    response({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'managed-project' }),
  );
  const auth = createGoogleSubscriptionAuth(chrome, fetch);
  return { auth, identity, fetch, session, local };
}
describe('experimental Google account bridge', () => {
  it('requires configured OAuth and explicit local login, with no background popup', async () => {
    const missing = fixture(false);
    await expect(missing.auth.login()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(missing.identity.getAuthToken).not.toHaveBeenCalled();
    const f = fixture();
    await expect(f.auth.authorize(profile)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(f.identity.getAuthToken).not.toHaveBeenCalled();
  });
  it('keeps credentials out of storage and binds requests to the fixed backend after fresh access checks', async () => {
    const f = fixture();
    await f.auth.login();
    const authorized = await f.auth.authorize(profile);
    await f.auth.authorize(profile);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.identity.getAuthToken.mock.calls).toEqual([
      [{ interactive: true }],
      [{ interactive: false }],
      [{ interactive: false }],
    ]);
    expect(JSON.stringify(f.session.values)).not.toContain('private-google-token');
    const adapted = nativeRequest(
      authorized,
      JSON.stringify({
        model: 'gemini-test',
        instructions: 'Help',
        input: [{ type: 'message', role: 'user', content: 'Hello' }],
        tools: [],
        stream: true,
      }),
    );
    expect(adapted.endpoint).toBe(GOOGLE_SUBSCRIPTION_ENDPOINT);
    expect(JSON.parse(adapted.body)).toMatchObject({
      model: 'gemini-test',
      project: 'managed-project',
      request: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
    });
    expect(adapted.body).not.toContain('private-google-token');
    expect(adapted.body).not.toContain('enabled_credit_types');
    expect(serverHeaders(authorized)).toEqual({ Authorization: 'Bearer private-google-token' });
    expect(f.fetch.mock.calls[0]?.[0]).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    );
    expect(() => normalizeResponsesConnection(authorized)).toThrow(); // Never persist injected token.
    expect(() =>
      normalizeResponsesConnection({ ...profile, endpoint: 'https://evil.example' }),
    ).toThrow();
    const decoded = nativeResponse(
      'gemini-subscription',
      JSON.stringify({
        response: {
          candidates: [
            { finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'done' }] } },
          ],
        },
      }),
      'request',
    );
    expect(JSON.parse(decoded).output[0].content[0].text).toBe('done');
  });
  it('checks website authorization before obtaining a Google token', async () => {
    const f = fixture();
    await f.auth.login();
    const authorizer = {
      assertAuthorized: vi.fn(() => {
        throw new Error('Denied');
      }),
    };
    const store = createResponsesConnectionStore(
      f.local.api,
      { contains: async () => true, request: async () => true },
      authorizer,
      f.auth.authorize,
    );
    await store.save(profile);
    await expect(store.authorized(profile.id, {})).rejects.toThrow('Denied');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.identity.getAuthToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.local.values)).not.toContain('private-google-token');
  });
  it('logout defeats pending login and removes local authorization even if cache cleanup fails', async () => {
    const f = fixture();
    let finish!: (value: { token: string; grantedScopes: string[] }) => void;
    f.identity.getAuthToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const login = f.auth.login();
    const rejected = expect(login).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await vi.waitFor(() => expect(f.identity.getAuthToken).toHaveBeenCalledTimes(1));
    await f.auth.logout();
    finish({ token: 'late-token', grantedScopes: [GOOGLE_SUBSCRIPTION_SCOPE] });
    await rejected;
    await expect(f.auth.authorize(profile)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    f.identity.clearAllCachedAuthTokens.mockRejectedValue(new Error('private details'));
    await expect(f.auth.logout()).rejects.toThrow();
    expect(f.session.values['loom.google-subscription.authorized']).toBeUndefined();
  });
  it('logout wins even when interleaved with the final login storage write', async () => {
    const f = fixture();
    const original = f.session.api.set;
    vi.spyOn(f.session.api, 'set').mockImplementation(async (entries) => {
      if (String(entries['loom.google-subscription.authorized']).startsWith('ready:'))
        await f.auth.logout();
      await original(entries);
    });
    await expect(f.auth.login()).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await expect(f.auth.authorize(profile)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('does not accept a result from an account check after logout', async () => {
    const f = fixture();
    await f.auth.login();
    let finish!: (value: ReturnType<typeof response>) => void;
    f.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.auth.authorize(profile);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    await f.auth.logout();
    finish(response({ currentTier: { id: 'free' }, cloudaicompanionProject: 'project' }));
    await rejected;
  });
  it.each([
    [401, 'LOGIN_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [404, 'UNSUPPORTED'],
    [429, 'RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ] as const)(
    'sanitizes HTTP %s without retrying or silently enabling another billing route',
    async (status, code) => {
      const fetch = vi.fn<CodexModelFetch>(async () =>
        response({ error: { message: 'secret-token' } }, status),
      );
      await expect(
        checkGoogleSubscriptionAccess(undefined, 'secret-token', fetch),
      ).rejects.toMatchObject({ code, status });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('classifies network failures without exposing the cause', async () => {
    const fetch: CodexModelFetch = async () => {
      throw new Error('private-network-detail');
    };
    await expect(checkGoogleSubscriptionAccess(undefined, 'token', fetch)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
  it('requires a valid tier/project and does not automatically onboard', async () => {
    const fetch = vi.fn<CodexModelFetch>(async () => response({ allowedTiers: [{ id: 'free' }] }));
    await expect(checkGoogleSubscriptionAccess(undefined, 'token', fetch)).rejects.toMatchObject({
      code: 'ACCOUNT_SETUP_REQUIRED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds stalled account checks and aborts transport', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch: CodexModelFetch = async (_, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      };
      const pending = checkGoogleSubscriptionAccess(undefined, 'token', fetch);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
      await vi.advanceTimersByTimeAsync(8000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
