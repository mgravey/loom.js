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

function host(
  storage: MemoryStorage,
  sessionStorage = new MemoryStorage(),
): CodexChromeExtensionApi {
  return {
    identity: {
      getRedirectURL: () => 'https://extension-id.chromiumapp.org/codex-auth',
      launchWebAuthFlow: () => Promise.resolve(undefined),
    },
    runtime: {
      id: 'extension-id',
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      onMessageExternal: { addListener: vi.fn() },
      onConnectExternal: { addListener: vi.fn() },
    },
    declarativeNetRequest: { updateSessionRules: vi.fn(() => Promise.resolve()) },
    tabs: {
      create: vi.fn(() => Promise.resolve({ id: 1 })),
      update: vi.fn(() => Promise.resolve({ id: 1 })),
      getCurrent: vi.fn(() => Promise.resolve({ id: 1 })),
      remove: vi.fn(() => Promise.resolve()),
    },
    storage: { local: storage, session: sessionStorage },
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

  it('keeps refresh and routing data in session storage and never returns access tokens externally', async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const fetchRequest = vi.fn<OAuthFetch>().mockResolvedValue({
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ access_token: 'secret-access-token', expires_in: 3600 })),
    });
    const composition = createCodexExperimentalExtension({
      chromeApi: host(localStorage, sessionStorage),
      fetchRequest,
    });
    await composition.settings.setDeviceAuthorizationEnabled(true);
    await composition.credentialStore.set(composition.providerId, {
      value: 'session-refresh-token',
    });
    await composition.accountRoutingStore.set('account-test');

    const response = await new Promise<unknown>((resolve) => {
      composition.externalMessageListener(
        {
          protocol: 'loom/credential-broker',
          version: 1,
          type: 'getAccessToken',
          requestId: 'no-token-exfiltration',
          providerId: composition.providerId,
        },
        { origin: 'http://localhost:4173', url: 'http://localhost:4173/workbench.html' },
        resolve,
      );
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED_REQUEST' },
    });
    expect(JSON.stringify(response)).not.toContain('secret-access-token');
    expect(fetchRequest).not.toHaveBeenCalled();
    expect([...localStorage.entries.values()]).not.toContain('session-refresh-token');
    expect([...sessionStorage.entries.values()]).toContain('session-refresh-token');
  });

  it('persists opted-in authorization across a browser restart and removes it on logout', async () => {
    const localStorage = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const fetchRequest = vi.fn<OAuthFetch>().mockResolvedValue({
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            access_token: 'temporary-access-token',
            refresh_token: 'rotated-persistent-refresh',
            expires_in: 3600,
          }),
        ),
    });
    const first = createCodexExperimentalExtension({
      chromeApi: host(localStorage, firstSession),
      fetchRequest,
    });
    await first.settings.setDeviceAuthorizationEnabled(true);
    await first.credentialPersistence.setMode('local');
    await first.credentialPersistence.saveAuthorization(
      first.providerId,
      { value: 'initial-persistent-refresh' },
      'account-persistent',
    );
    await expect(first.tokenService.getAccessToken(first.providerId)).resolves.toEqual(
      expect.objectContaining({ accessToken: 'temporary-access-token' }),
    );
    expect([...localStorage.entries.values()]).toEqual(
      expect.arrayContaining(['local', 'rotated-persistent-refresh', 'account-persistent']),
    );
    expect([...firstSession.entries.values()]).not.toContain('rotated-persistent-refresh');

    const restartedSession = new MemoryStorage();
    const restarted = createCodexExperimentalExtension({
      chromeApi: host(localStorage, restartedSession),
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    await expect(restarted.tokenService.getStatus(restarted.providerId)).resolves.toEqual({
      authenticated: true,
    });

    await restarted.tokenService.logout(restarted.providerId);
    expect([...localStorage.entries.values()]).not.toContain('rotated-persistent-refresh');
    expect([...localStorage.entries.values()]).not.toContain('account-persistent');
    expect([...restartedSession.entries.values()]).not.toContain('rotated-persistent-refresh');
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
        credentialPersistence: composition.credentialPersistence,
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
      credentialPersistence: composition.credentialPersistence,
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
        credentialPersistence: composition.credentialPersistence,
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
