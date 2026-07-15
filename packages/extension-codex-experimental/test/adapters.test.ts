import type { AuthorizationTransaction } from '@loom/auth-codex-experimental';
import type { ChromeStorageArea } from '@loom/extension';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserDelay,
  createChromeIdentityRedirect,
  createChromeSessionAuthorizationTransactionStore,
  createFetchOAuthTransport,
  createWebCryptoRandomSource,
  createWebCryptoSha256Digest,
} from '../src/adapters.js';
import type { BrowserCrypto, OAuthFetch } from '../src/chrome-contracts.js';

class MemoryStorage implements ChromeStorageArea {
  readonly entries = new Map<string, unknown>();
  readonly accessLevels: string[] = [];

  setAccessLevel(options: { readonly accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    this.accessLevels.push(options.accessLevel);
    return Promise.resolve();
  }

  get(key: string): Promise<Record<string, unknown>> {
    return Promise.resolve({ [key]: this.entries.get(key) });
  }

  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.entries.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

describe('Codex extension host adapters', () => {
  it('sends only POST requests to the exact configured auth origin', async () => {
    const request = vi.fn<OAuthFetch>().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('{"ok":true}'),
    });
    const transport = createFetchOAuthTransport(request);

    await expect(
      transport.send({
        method: 'POST',
        url: 'https://auth.openai.com/oauth/token',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    expect(request).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      }),
    );

    await expect(
      transport.send({
        method: 'POST',
        url: 'https://auth.openai.com.evil.invalid/oauth/token',
        headers: {},
        body: '',
      }),
    ).rejects.toThrow(/outside/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('adapts injected Web Crypto and browser timing without ambient globals', async () => {
    const cryptoApi: BrowserCrypto = {
      getRandomValues(array) {
        array.fill(7);
        return array;
      },
      subtle: {
        digest: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      },
    };
    await expect(
      createWebCryptoSha256Digest(cryptoApi).digest(new Uint8Array([9])),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(createWebCryptoRandomSource(cryptoApi).randomBytes(3)).toEqual(
      new Uint8Array([7, 7, 7]),
    );
    expect(() => createWebCryptoRandomSource(cryptoApi).randomBytes(0)).toThrow(RangeError);

    const schedule = vi.fn((callback: () => void) => callback());
    await createBrowserDelay(schedule).wait(25);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 25);
  });

  it('keeps the chrome.identity adapter unavailable until redirect registration is approved', async () => {
    const identity = {
      getRedirectURL: vi.fn(() => 'https://extension-id.chromiumapp.org/codex-auth'),
      launchWebAuthFlow: vi.fn(() =>
        Promise.resolve('https://extension-id.chromiumapp.org/codex-auth?code=x&state=y'),
      ),
    };
    expect(() =>
      createChromeIdentityRedirect(identity, { redirectRegistrationApproved: false }),
    ).toThrow(/approved redirect/);
    expect(identity.getRedirectURL).not.toHaveBeenCalled();

    const redirect = createChromeIdentityRedirect(identity, {
      redirectRegistrationApproved: true,
    });
    expect(redirect.getRedirectUri()).toBe('https://extension-id.chromiumapp.org/codex-auth');
    await expect(
      redirect.launchAuthorization('https://auth.openai.com/oauth/authorize'),
    ).resolves.toContain('?code=x');
    expect(identity.launchWebAuthFlow).toHaveBeenCalledWith({
      url: 'https://auth.openai.com/oauth/authorize',
      interactive: true,
    });
  });

  it('keeps direct-flow PKCE transactions in trusted session storage and consumes them once', async () => {
    const storage = new MemoryStorage();
    expect(() => createChromeSessionAuthorizationTransactionStore(storage, false)).toThrow(
      /disabled/,
    );
    const store = createChromeSessionAuthorizationTransactionStore(storage, true);
    const transaction: AuthorizationTransaction = Object.freeze({
      providerId: 'openai/codex-experimental',
      state: 'state',
      verifier: 'verifier',
      redirectUri: 'https://extension-id.chromiumapp.org/codex-auth',
      createdAt: 42,
    });
    await store.put(transaction);

    await expect(store.take(transaction.providerId)).resolves.toEqual(transaction);
    await expect(store.take(transaction.providerId)).resolves.toBeUndefined();
    expect(storage.accessLevels).toEqual(['TRUSTED_CONTEXTS']);
  });
});
