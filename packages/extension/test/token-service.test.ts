import { describe, expect, it, vi } from 'vitest';

import {
  ExtensionBrokerError,
  createExtensionTokenService,
  createMemoryRefreshCredentialStore,
  type ExtensionCredentialProvider,
  type StoredRefreshCredential,
} from '../src/index.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('extension token service', () => {
  it('deduplicates refresh, rotates credentials, and caches a valid access token', async () => {
    let now = 1_000;
    const refresh = deferred<{
      accessToken: string;
      expiresAt: number;
      nextRefreshCredential: StoredRefreshCredential;
    }>();
    const provider: ExtensionCredentialProvider = {
      id: 'test/provider',
      refresh: vi.fn(() => refresh.promise),
    };
    const credentialStore = createMemoryRefreshCredentialStore({
      'test/provider': 'private-refresh-value',
    });
    const service = createExtensionTokenService({
      providers: [provider],
      credentialStore,
      clock: { now: () => now },
      expirationSkewMs: 100,
    });

    const first = service.getAccessToken('test/provider');
    const second = service.getAccessToken('test/provider');
    refresh.resolve({
      accessToken: 'short-lived-access-token',
      expiresAt: 2_000,
      nextRefreshCredential: { value: 'rotated-private-value' },
    });

    await expect(first).resolves.toEqual({
      accessToken: 'short-lived-access-token',
      expiresAt: 2_000,
    });
    await expect(second).resolves.toEqual({
      accessToken: 'short-lived-access-token',
      expiresAt: 2_000,
    });
    expect(provider.refresh).toHaveBeenCalledOnce();
    expect(await credentialStore.get('test/provider')).toEqual({
      value: 'rotated-private-value',
    });

    await service.getAccessToken('test/provider');
    expect(provider.refresh).toHaveBeenCalledOnce();
    now = 1_901;
    await service.getAccessToken('test/provider');
    expect(provider.refresh).toHaveBeenCalledTimes(2);
    service.clearCachedAccessToken('test/provider');
  });

  it('reports unknown and missing providers without exposing credentials', async () => {
    const provider: ExtensionCredentialProvider = {
      id: 'test/provider',
      refresh: vi.fn(),
    };
    const service = createExtensionTokenService({
      providers: [provider],
      credentialStore: createMemoryRefreshCredentialStore(),
      clock: { now: () => 0 },
    });

    await expect(service.getAccessToken('test/unknown')).rejects.toMatchObject({
      code: 'UNKNOWN_PROVIDER',
    });
    await expect(service.getAccessToken('test/provider')).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    });
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it('sanitizes provider failures and rejects invalid results', async () => {
    const secret = 'do-not-leak-this-refresh-value';
    const failing: ExtensionCredentialProvider = {
      id: 'test/failing',
      refresh: vi.fn(() => {
        throw new Error(`provider included ${secret}`);
      }),
    };
    const invalid: ExtensionCredentialProvider = {
      id: 'test/invalid',
      refresh: vi.fn(async () => ({ accessToken: '', expiresAt: 2_000 })),
    };
    const service = createExtensionTokenService({
      providers: [failing, invalid],
      credentialStore: createMemoryRefreshCredentialStore({
        'test/failing': secret,
        'test/invalid': secret,
      }),
      clock: { now: () => 1_000 },
    });

    const failure = await service.getAccessToken('test/failing').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtensionBrokerError);
    expect((failure as Error).message).not.toContain(secret);
    await expect(service.getAccessToken('test/invalid')).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
    });
  });

  it('validates providers and expiration skew', () => {
    const store = createMemoryRefreshCredentialStore();
    const provider: ExtensionCredentialProvider = {
      id: 'test/provider',
      refresh: vi.fn(),
    };
    expect(() =>
      createExtensionTokenService({
        providers: [provider, provider],
        credentialStore: store,
      }),
    ).toThrow(/Duplicate credential provider/);
    expect(() =>
      createExtensionTokenService({
        providers: [{ id: '', refresh: vi.fn() }],
        credentialStore: store,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createExtensionTokenService({
        providers: [],
        credentialStore: store,
        expirationSkewMs: -1,
      }),
    ).toThrow(RangeError);
  });
});
