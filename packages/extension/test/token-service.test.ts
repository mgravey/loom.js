import { describe, expect, it, vi } from 'vitest';

import {
  CredentialProviderError,
  ExtensionBrokerError,
  createExtensionTokenService,
  createMemoryRefreshCredentialStore,
  type ExtensionCredentialProvider,
  type RefreshCredentialStore,
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

  it('accepts authorization results only after rotated credentials persist', async () => {
    const persisted = deferred<undefined>();
    const set = vi.fn(() => persisted.promise);
    const store: RefreshCredentialStore = {
      get: vi.fn(async () => undefined),
      set,
      delete: vi.fn(async () => undefined),
    };
    const provider: ExtensionCredentialProvider = {
      id: 'test/provider',
      refresh: vi.fn(),
    };
    const service = createExtensionTokenService({
      providers: [provider],
      credentialStore: store,
      clock: { now: () => 1_000 },
    });

    const accepted = service.acceptAuthorizationResult('test/provider', {
      accessToken: 'authorized-access',
      expiresAt: 2_000,
      nextRefreshCredential: { value: 'authorized-refresh' },
    });
    const concurrent = service.getAccessToken('test/provider');
    let settled = false;
    void accepted.finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(set).toHaveBeenCalledWith('test/provider', { value: 'authorized-refresh' });
    expect(settled).toBe(false);
    expect(provider.refresh).not.toHaveBeenCalled();

    persisted.resolve(undefined);
    await expect(accepted).resolves.toEqual({
      accessToken: 'authorized-access',
      expiresAt: 2_000,
    });
    await expect(concurrent).resolves.toEqual({
      accessToken: 'authorized-access',
      expiresAt: 2_000,
    });
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it('deletes permanently rejected credentials and requires authorization again', async () => {
    const credentialStore = createMemoryRefreshCredentialStore({
      'test/provider': 'permanently-rejected',
    });
    const deleteCredential = vi.spyOn(credentialStore, 'delete');
    const provider: ExtensionCredentialProvider = {
      id: 'test/provider',
      refresh: vi.fn(() => {
        throw new CredentialProviderError('CREDENTIAL_REJECTED', 'Provider rejected credential.');
      }),
    };
    const service = createExtensionTokenService({
      providers: [provider],
      credentialStore,
      clock: { now: () => 1_000 },
    });

    await expect(service.getAccessToken('test/provider')).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    });
    expect(deleteCredential).toHaveBeenCalledWith('test/provider');
    expect(await credentialStore.get('test/provider')).toBeUndefined();

    await expect(service.getAccessToken('test/provider')).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    });
    expect(provider.refresh).toHaveBeenCalledOnce();
  });

  it.each(['TEMPORARY_FAILURE', 'INVALID_RESPONSE'] as const)(
    'retains credentials after provider %s',
    async (code) => {
      const credentialStore = createMemoryRefreshCredentialStore({
        'test/provider': 'still-valid',
      });
      const provider: ExtensionCredentialProvider = {
        id: 'test/provider',
        refresh: vi.fn(() => {
          throw new CredentialProviderError(code, 'Sanitized provider failure.');
        }),
      };
      const service = createExtensionTokenService({
        providers: [provider],
        credentialStore,
      });

      await expect(service.getAccessToken('test/provider')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      });
      expect(await credentialStore.get('test/provider')).toEqual({ value: 'still-valid' });
    },
  );

  it('validates authorization results and provider IDs', async () => {
    const service = createExtensionTokenService({
      providers: [{ id: 'test/provider', refresh: vi.fn() }],
      credentialStore: createMemoryRefreshCredentialStore(),
      clock: { now: () => 1_000 },
    });

    await expect(
      service.acceptAuthorizationResult('test/unknown', {
        accessToken: 'access',
        expiresAt: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' });
    await expect(
      service.acceptAuthorizationResult('test/provider', {
        accessToken: 'access',
        expiresAt: 2_000,
        nextRefreshCredential: { value: '' },
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
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
