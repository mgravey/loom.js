import { createHash } from 'node:crypto';

import type { ChromeStorageArea } from '@loom/extension';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_BROWSER_AUTHORIZATION_TTL_MS,
  CODEX_CALLBACK_RULE_ID,
  completeBrowserAuthorization,
  createBrowserAuthorizationBridgeStore,
  startBrowserAuthorization,
} from '../src/browser-authorization.js';
import type {
  BrowserCrypto,
  ChromeDeclarativeNetRequestRule,
  ChromeTabsApi,
  OAuthFetch,
} from '../src/chrome-contracts.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from '../src/composition.js';
import { createCodexCredentialPersistence } from '../src/credential-persistence.js';
import { createCodexExperimentSettings } from '../src/settings.js';

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

function idToken(accountId = 'account-browser'): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

function cryptoApi(): BrowserCrypto {
  return {
    getRandomValues(array) {
      array.fill(8);
      return array;
    },
    subtle: {
      digest(_algorithm, data) {
        return Promise.resolve(createHash('sha256').update(data).digest().buffer as ArrayBuffer);
      },
    },
  };
}

function tabs(currentTabId = 17): ChromeTabsApi & { readonly updatedUrls: string[] } {
  const updatedUrls: string[] = [];
  return {
    updatedUrls,
    create: vi.fn(() => Promise.resolve({ id: 17 })),
    update: vi.fn((_tabId, options) => {
      updatedUrls.push(options.url);
      return Promise.resolve({ id: 17 });
    }),
    getCurrent: vi.fn(() => Promise.resolve({ id: currentTabId })),
    remove: vi.fn(() => Promise.resolve()),
  };
}

function fixture(now = 1_000) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const settings = createCodexExperimentSettings(local);
  const credentialPersistence = createCodexCredentialPersistence({
    settings,
    localStorage: local,
    sessionStorage: session,
    providerId: CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
  });
  const bridgeStore = createBrowserAuthorizationBridgeStore(session);
  const rules = new Map<number, ChromeDeclarativeNetRequestRule>();
  const ruleCalls: unknown[] = [];
  const declarativeNetRequest = {
    updateSessionRules: vi.fn(
      (options: {
        readonly removeRuleIds?: readonly number[];
        readonly addRules?: readonly ChromeDeclarativeNetRequestRule[];
      }) => {
        ruleCalls.push(options);
        for (const id of options.removeRuleIds ?? []) rules.delete(id);
        for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
        return Promise.resolve();
      },
    ),
  };
  const tabsApi = tabs();
  const common = {
    settings,
    credentialPersistence,
    transactionStorage: session,
    bridgeStore,
    declarativeNetRequest,
    tabs: tabsApi,
    cryptoApi: cryptoApi(),
    now: () => now,
  };
  return { local, session, rules, ruleCalls, tabsApi, common };
}

describe('extension-owned ChatGPT browser authorization', () => {
  it('installs an exact tab-scoped session redirect and preserves the callback query', async () => {
    const state = fixture();
    await state.common.settings.setDeviceAuthorizationEnabled(true);
    await startBrowserAuthorization({
      ...state.common,
      callbackUrl: 'chrome-extension://extension-id/callback.html',
      fetchRequest: vi.fn<OAuthFetch>(),
    });

    const rule = state.rules.get(CODEX_CALLBACK_RULE_ID);
    expect(rule).toMatchObject({
      condition: {
        regexFilter: '^http://localhost:1455/auth/callback(?:\\?(.*))?$',
        resourceTypes: ['main_frame'],
        tabIds: [17],
      },
      action: {
        redirect: { regexSubstitution: 'chrome-extension://extension-id/callback.html?\\1' },
      },
    });
    const authorizationUrl = new URL(state.tabsApi.updatedUrls[0] as string);
    expect(authorizationUrl.origin).toBe('https://auth.openai.com');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    );
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('validates state, exchanges once, and persists no access or ID token', async () => {
    const state = fixture();
    await state.common.settings.setDeviceAuthorizationEnabled(true);
    await startBrowserAuthorization({
      ...state.common,
      callbackUrl: 'chrome-extension://extension-id/callback.html',
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    const authorizationUrl = new URL(state.tabsApi.updatedUrls[0] as string);
    const oauthState = authorizationUrl.searchParams.get('state');
    const fetchRequest = vi.fn<OAuthFetch>().mockResolvedValue({
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            access_token: 'temporary-access',
            refresh_token: 'private-refresh',
            id_token: idToken(),
            expires_in: 3600,
          }),
        ),
    });
    await completeBrowserAuthorization({
      ...state.common,
      fetchRequest,
      callbackSearch: `?code=authorization-code&state=${String(oauthState)}`,
    });

    expect(fetchRequest).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        body: expect.stringContaining(
          'redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
        ),
      }),
    );
    await expect(
      state.common.credentialPersistence.credentialStore.get(
        CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
      ),
    ).resolves.toEqual({ value: 'private-refresh' });
    await expect(state.common.credentialPersistence.accountRoutingStore.get()).resolves.toBe(
      'account-browser',
    );
    expect([...state.local.entries.values()]).not.toContain('temporary-access');
    expect([...state.local.entries.values()]).not.toContain(idToken());
    expect([...state.session.entries.values()]).not.toContain('temporary-access');
    expect([...state.session.entries.values()]).not.toContain(idToken());
    expect(state.rules.size).toBe(0);

    await expect(
      completeBrowserAuthorization({
        ...state.common,
        fetchRequest,
        callbackSearch: `?code=replayed&state=${String(oauthState)}`,
      }),
    ).rejects.toThrow(/missing or was already consumed/);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects expired and wrong-tab callbacks without exchanging credentials', async () => {
    let now = 1_000;
    const state = fixture();
    const common = { ...state.common, now: () => now };
    await common.settings.setDeviceAuthorizationEnabled(true);
    await startBrowserAuthorization({
      ...common,
      callbackUrl: 'chrome-extension://extension-id/callback.html',
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    const fetchRequest = vi.fn<OAuthFetch>();

    await expect(
      completeBrowserAuthorization({
        ...common,
        tabs: tabs(99),
        fetchRequest,
        callbackSearch: '?code=x&state=x',
      }),
    ).rejects.toThrow(/missing or was already consumed/);
    expect(await state.common.bridgeStore.get()).toBeDefined();

    now += CODEX_BROWSER_AUTHORIZATION_TTL_MS + 1;
    await expect(
      completeBrowserAuthorization({
        ...common,
        fetchRequest,
        callbackSearch: '?code=x&state=x',
      }),
    ).rejects.toThrow(/expired/);
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(state.rules.size).toBe(0);
    expect(await state.common.bridgeStore.get()).toBeUndefined();
  });

  it('consumes a mismatched state callback and prevents replay', async () => {
    const state = fixture();
    await state.common.settings.setDeviceAuthorizationEnabled(true);
    await startBrowserAuthorization({
      ...state.common,
      callbackUrl: 'chrome-extension://extension-id/callback.html',
      fetchRequest: vi.fn<OAuthFetch>(),
    });
    const fetchRequest = vi.fn<OAuthFetch>();

    await expect(
      completeBrowserAuthorization({
        ...state.common,
        fetchRequest,
        callbackSearch: '?code=authorization-code&state=attacker-state',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(state.rules.size).toBe(0);

    await expect(
      completeBrowserAuthorization({
        ...state.common,
        fetchRequest,
        callbackSearch: '?code=replay&state=attacker-state',
      }),
    ).rejects.toThrow(/missing or was already consumed/);
  });
});
