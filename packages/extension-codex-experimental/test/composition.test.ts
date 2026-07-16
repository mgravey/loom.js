import type { ChromeStorageArea } from '@loom/extension';
import { describe, expect, it, vi } from 'vitest';

import type { CodexChromeExtensionApi, OAuthFetch } from '../src/chrome-contracts.js';
import {
  CODEX_EXPERIMENTAL_CONFIGURATION,
  createCodexExperimentalExtension,
} from '../src/composition.js';
import { runManualDeviceAuthorization } from '../src/manual-authorization.js';

function idToken(accountId = 'account-test'): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

class MemoryStorage implements ChromeStorageArea {
  readonly entries = new Map<string, unknown>();
  accessLevelCalls = 0;

  setAccessLevel(): Promise<void> {
    this.accessLevelCalls += 1;
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

function host(storage: MemoryStorage): CodexChromeExtensionApi {
  return {
    identity: {
      getRedirectURL: () => 'https://extension-id.chromiumapp.org/codex-auth',
      launchWebAuthFlow: () => Promise.resolve(undefined),
    },
    runtime: {
      onMessageExternal: { addListener: vi.fn() },
      onConnectExternal: { addListener: vi.fn() },
    },
    storage: { local: storage, session: new MemoryStorage() },
  };
}

describe('Codex experimental extension composition', () => {
  it('identifies itself as Loom instead of impersonating the audited CLI host', () => {
    expect(CODEX_EXPERIMENTAL_CONFIGURATION.authorizationParameters?.originator).toBe(
      'loom_extension_experiment',
    );
  });

  it('is disabled by default and checks the gate before serving cached or stored tokens', async () => {
    const storage = new MemoryStorage();
    const fetchRequest = vi.fn<OAuthFetch>();
    const composition = createCodexExperimentalExtension({
      chromeApi: host(storage),
      fetchRequest,
    });

    await expect(
      composition.tokenService.getAccessToken(composition.providerId),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
    await expect(composition.tokenService.getStatus(composition.providerId)).resolves.toEqual({
      authenticated: false,
    });
    expect(fetchRequest).not.toHaveBeenCalled();

    await composition.settings.setDeviceAuthorizationEnabled(true);
    await expect(
      composition.tokenService.getAccessToken(composition.providerId),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('does not surface a stale cached token after disable and re-enable', async () => {
    const storage = new MemoryStorage();
    const fetchRequest = vi.fn<OAuthFetch>().mockResolvedValue({
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            access_token: 'short-lived-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
          }),
        ),
    });
    const composition = createCodexExperimentalExtension({
      chromeApi: host(storage),
      fetchRequest,
    });
    await composition.settings.setDeviceAuthorizationEnabled(true);
    await composition.credentialStore.set(composition.providerId, {
      value: 'initial-refresh-token',
    });
    await composition.accountRoutingStore.set('account-test');
    await expect(composition.tokenService.getAccessToken(composition.providerId)).resolves.toEqual(
      expect.objectContaining({ accessToken: 'short-lived-access-token' }),
    );

    await composition.settings.setDeviceAuthorizationEnabled(false);
    await composition.credentialStore.delete(composition.providerId);
    await composition.settings.setDeviceAuthorizationEnabled(true);

    await expect(
      composition.tokenService.getAccessToken(composition.providerId),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('treats a refresh credential without account routing as incomplete authorization', async () => {
    const storage = new MemoryStorage();
    const fetchRequest = vi.fn<OAuthFetch>();
    const composition = createCodexExperimentalExtension({
      chromeApi: host(storage),
      fetchRequest,
    });
    await composition.settings.setDeviceAuthorizationEnabled(true);
    await composition.credentialStore.set(composition.providerId, {
      value: 'orphaned-refresh-token',
    });

    await expect(composition.tokenService.getStatus(composition.providerId)).resolves.toEqual({
      authenticated: false,
    });
    await expect(
      composition.tokenService.getAccessToken(composition.providerId),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
    expect(fetchRequest).not.toHaveBeenCalled();

    await composition.accountRoutingStore.set('account-test');
    await expect(composition.tokenService.getStatus(composition.providerId)).resolves.toEqual({
      authenticated: true,
    });
  });

  it('runs device authorization only after opt-in and persists only the refresh credential', async () => {
    const storage = new MemoryStorage();
    const composition = createCodexExperimentalExtension({
      chromeApi: host(storage),
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    const responses = [
      {
        status: 200,
        body: JSON.stringify({
          device_auth_id: 'device-id',
          user_code: 'ABCD-1234',
          interval: '1',
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          authorization_code: 'authorization-code',
          code_verifier: 'a'.repeat(43),
          code_challenge: 'AQID',
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          id_token: idToken(),
          access_token: 'temporary-access-token',
          refresh_token: 'private-refresh-token',
          expires_in: 3600,
        }),
      },
    ];
    const fetchRequest = vi.fn<OAuthFetch>().mockImplementation(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected request');
      return Promise.resolve({
        status: response.status,
        text: () => Promise.resolve(response.body),
      });
    });
    const prompt = vi.fn(() => Promise.resolve());
    const cryptoApi = {
      getRandomValues<T extends Uint8Array>(array: T): T {
        array.fill(1);
        return array;
      },
      subtle: {
        digest: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      },
    };

    await expect(
      runManualDeviceAuthorization({
        settings: composition.settings,
        credentialStore: composition.credentialStore,
        accountRoutingStore: composition.accountRoutingStore,
        host: {
          fetchRequest,
          cryptoApi,
          schedule: (callback) => callback(),
          presentChallenge: prompt,
        },
      }),
    ).rejects.toThrow(/disabled/);
    expect(fetchRequest).not.toHaveBeenCalled();

    await composition.settings.setDeviceAuthorizationEnabled(true);
    await runManualDeviceAuthorization({
      settings: composition.settings,
      credentialStore: composition.credentialStore,
      accountRoutingStore: composition.accountRoutingStore,
      host: {
        fetchRequest,
        cryptoApi,
        schedule: (callback) => callback(),
        presentChallenge: prompt,
      },
    });

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      }),
    );
    await expect(
      composition.credentialStore.get(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
    ).resolves.toEqual({ value: 'private-refresh-token' });
    await expect(composition.accountRoutingStore.get()).resolves.toBe('account-test');
    expect([...storage.entries.values()]).not.toContain('temporary-access-token');
  });

  it('does not persist authorization completed after the experiment is disabled', async () => {
    const storage = new MemoryStorage();
    const composition = createCodexExperimentalExtension({
      chromeApi: host(storage),
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    const responses = [
      {
        status: 200,
        body: JSON.stringify({
          device_auth_id: 'device-id',
          user_code: 'ABCD-1234',
          interval: '1',
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          authorization_code: 'authorization-code',
          code_verifier: 'a'.repeat(43),
          code_challenge: 'AQID',
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          access_token: 'temporary-access-token',
          refresh_token: 'must-not-be-persisted',
          expires_in: 3600,
        }),
      },
    ];
    const fetchRequest = vi.fn<OAuthFetch>().mockImplementation(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected request');
      return Promise.resolve({
        status: response.status,
        text: () => Promise.resolve(response.body),
      });
    });
    const cryptoApi = {
      getRandomValues<T extends Uint8Array>(array: T): T {
        array.fill(1);
        return array;
      },
      subtle: {
        digest: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      },
    };
    await composition.settings.setDeviceAuthorizationEnabled(true);

    await expect(
      runManualDeviceAuthorization({
        settings: composition.settings,
        credentialStore: composition.credentialStore,
        accountRoutingStore: composition.accountRoutingStore,
        host: {
          fetchRequest,
          cryptoApi,
          schedule: (callback) => callback(),
          async presentChallenge() {
            await composition.settings.setDeviceAuthorizationEnabled(false);
          },
        },
      }),
    ).rejects.toThrow(/disabled before completion/);

    await expect(
      composition.credentialStore.get(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
    ).resolves.toBeUndefined();
    expect([...storage.entries.values()]).not.toContain('must-not-be-persisted');
  });
});
