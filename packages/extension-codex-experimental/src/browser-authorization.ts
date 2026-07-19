import {
  completeCodexExperimentalRedirectAuthorization,
  createCodexExperimentalRedirectAuthorizationRequest,
} from '@loom/auth-codex-experimental';
import type { ChromeStorageArea } from '@loom/extension';

import { chatGptAccountIdFromIdToken } from './account-routing.js';
import {
  createChromeSessionAuthorizationTransactionStore,
  createFetchOAuthTransport,
  createWebCryptoRandomSource,
  createWebCryptoSha256Digest,
} from './adapters.js';
import type {
  BrowserCrypto,
  ChromeDeclarativeNetRequestApi,
  ChromeTabsApi,
  OAuthFetch,
} from './chrome-contracts.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from './composition.js';
import type { CodexCredentialPersistence } from './credential-persistence.js';
import type { CodexExperimentSettings } from './settings.js';

export const CODEX_LOCALHOST_CALLBACK_URI = 'http://localhost:1455/auth/callback' as const;
export const CODEX_EXTENSION_CALLBACK_PATH = 'callback.html' as const;
export const CODEX_CALLBACK_RULE_ID = 1_455_001 as const;
export const CODEX_BROWSER_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;

const BRIDGE_KEY = 'loom.codex-experimental.browser-authorization-bridge';

export interface BrowserAuthorizationBridge {
  readonly providerId: string;
  readonly tabId: number;
  readonly ruleId: number;
  readonly createdAt: number;
}

export interface BrowserAuthorizationBridgeStore {
  get(): Promise<BrowserAuthorizationBridge | undefined>;
  put(value: BrowserAuthorizationBridge): Promise<void>;
  takeForTab(tabId: number): Promise<BrowserAuthorizationBridge | undefined>;
  delete(): Promise<void>;
}

function parseBridge(value: unknown): BrowserAuthorizationBridge | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BrowserAuthorizationBridge>;
  const tabId = candidate.tabId;
  const ruleId = candidate.ruleId;
  if (
    typeof candidate.providerId !== 'string' ||
    typeof tabId !== 'number' ||
    !Number.isSafeInteger(tabId) ||
    typeof ruleId !== 'number' ||
    !Number.isSafeInteger(ruleId) ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: candidate.providerId,
    tabId,
    ruleId,
    createdAt: candidate.createdAt,
  });
}

export function createBrowserAuthorizationBridgeStore(
  storage: ChromeStorageArea,
): BrowserAuthorizationBridgeStore {
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return Object.freeze({
    async get() {
      await ready;
      const values = await storage.get(BRIDGE_KEY);
      return parseBridge(values[BRIDGE_KEY]);
    },
    async put(value: BrowserAuthorizationBridge) {
      await ready;
      await storage.set({ [BRIDGE_KEY]: value });
    },
    async takeForTab(tabId: number) {
      await ready;
      const values = await storage.get(BRIDGE_KEY);
      const value = parseBridge(values[BRIDGE_KEY]);
      if (value?.tabId !== tabId) return undefined;
      await storage.remove(BRIDGE_KEY);
      return value;
    },
    async delete() {
      await ready;
      await storage.remove(BRIDGE_KEY);
    },
  });
}

interface BrowserAuthorizationCommonOptions {
  readonly settings: CodexExperimentSettings;
  readonly credentialPersistence: CodexCredentialPersistence;
  readonly transactionStorage: ChromeStorageArea;
  readonly bridgeStore: BrowserAuthorizationBridgeStore;
  readonly declarativeNetRequest: ChromeDeclarativeNetRequestApi;
  readonly tabs: ChromeTabsApi;
  readonly fetchRequest: OAuthFetch;
  readonly cryptoApi: BrowserCrypto;
  readonly now?: () => number;
}

export interface StartBrowserAuthorizationOptions extends BrowserAuthorizationCommonOptions {
  readonly callbackUrl: string;
}

export interface CompleteBrowserAuthorizationOptions extends BrowserAuthorizationCommonOptions {
  readonly callbackSearch: string;
}

async function removeRule(
  declarativeNetRequest: ChromeDeclarativeNetRequestApi,
  ruleId: number = CODEX_CALLBACK_RULE_ID,
): Promise<void> {
  await declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

async function removeTab(tabs: ChromeTabsApi, tabId: number): Promise<void> {
  try {
    await tabs.remove(tabId);
  } catch {
    // A user may close the transient tab before cleanup completes.
  }
}

export async function clearBrowserAuthorization(options: {
  readonly bridgeStore: BrowserAuthorizationBridgeStore;
  readonly transactionStorage: ChromeStorageArea;
  readonly declarativeNetRequest: ChromeDeclarativeNetRequestApi;
}): Promise<void> {
  const transactionStore = createChromeSessionAuthorizationTransactionStore(
    options.transactionStorage,
    true,
  );
  const bridge = await options.bridgeStore.get();
  await Promise.all([
    transactionStore.delete(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
    options.bridgeStore.delete(),
    removeRule(options.declarativeNetRequest, bridge?.ruleId),
  ]);
}

export async function startBrowserAuthorization(
  options: StartBrowserAuthorizationOptions,
): Promise<number> {
  if (!(await options.settings.isDeviceAuthorizationEnabled())) {
    throw new Error('The experimental ChatGPT browser login is disabled.');
  }
  await clearBrowserAuthorization(options);
  const transactionStore = createChromeSessionAuthorizationTransactionStore(
    options.transactionStorage,
    true,
  );
  const request = await createCodexExperimentalRedirectAuthorizationRequest(
    CODEX_EXPERIMENTAL_CONFIGURATION,
    {
      digest: createWebCryptoSha256Digest(options.cryptoApi),
      random: createWebCryptoRandomSource(options.cryptoApi),
      transactions: transactionStore,
      redirectUri: CODEX_LOCALHOST_CALLBACK_URI,
      clock: { now: options.now ?? Date.now },
      // This reuses the audited Codex loopback redirect. It remains an unsupported integration.
      redirectRegistrationApproved: true,
    },
  );
  let tabId: number | undefined;
  try {
    const tab = await options.tabs.create({ url: 'about:blank', active: true });
    if (typeof tab.id !== 'number' || !Number.isSafeInteger(tab.id)) {
      throw new Error('Chrome did not create an addressable tab.');
    }
    tabId = tab.id;
    await options.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [CODEX_CALLBACK_RULE_ID],
      addRules: [
        {
          id: CODEX_CALLBACK_RULE_ID,
          priority: 1,
          action: {
            type: 'redirect',
            redirect: { regexSubstitution: `${options.callbackUrl}?\\1` },
          },
          condition: {
            regexFilter: '^http://localhost:1455/auth/callback(?:\\?(.*))?$',
            resourceTypes: ['main_frame'],
            tabIds: [tabId],
          },
        },
      ],
    });
    await options.bridgeStore.put(
      Object.freeze({
        providerId: request.providerId,
        tabId,
        ruleId: CODEX_CALLBACK_RULE_ID,
        createdAt: (options.now ?? Date.now)(),
      }),
    );
    await options.tabs.update(tabId, { url: request.authorizationUrl });
    return tabId;
  } catch (error) {
    await clearBrowserAuthorization(options);
    if (tabId !== undefined) await removeTab(options.tabs, tabId);
    throw error;
  }
}

export async function completeBrowserAuthorization(
  options: CompleteBrowserAuthorizationOptions,
): Promise<void> {
  const currentTab = await options.tabs.getCurrent();
  if (typeof currentTab?.id !== 'number' || !Number.isSafeInteger(currentTab.id)) {
    throw new Error('The authorization callback is not running in an extension tab.');
  }
  const bridge = await options.bridgeStore.takeForTab(currentTab.id);
  if (bridge?.providerId !== CODEX_EXPERIMENTAL_CONFIGURATION.providerId) {
    throw new Error('The authorization callback is missing or was already consumed.');
  }
  const transactionStore = createChromeSessionAuthorizationTransactionStore(
    options.transactionStorage,
    true,
  );
  try {
    if ((options.now ?? Date.now)() - bridge.createdAt > CODEX_BROWSER_AUTHORIZATION_TTL_MS) {
      throw new Error('The authorization callback expired.');
    }
    if (options.callbackSearch !== '' && !options.callbackSearch.startsWith('?')) {
      throw new Error('The authorization callback query is invalid.');
    }
    const result = await completeCodexExperimentalRedirectAuthorization(
      CODEX_EXPERIMENTAL_CONFIGURATION,
      `${CODEX_LOCALHOST_CALLBACK_URI}${options.callbackSearch}`,
      {
        transport: createFetchOAuthTransport(options.fetchRequest),
        transactions: transactionStore,
        clock: { now: options.now ?? Date.now },
        transactionTtlMs: CODEX_BROWSER_AUTHORIZATION_TTL_MS,
        redirectRegistrationApproved: true,
      },
    );
    if (result.nextRefreshCredential === undefined || result.idToken === undefined) {
      throw new Error('Authorization completed without required credential metadata.');
    }
    if (!(await options.settings.isDeviceAuthorizationEnabled())) {
      throw new Error('The experimental ChatGPT browser login was disabled before completion.');
    }
    const accountId = chatGptAccountIdFromIdToken(result.idToken);
    await options.credentialPersistence.saveAuthorization(
      CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
      result.nextRefreshCredential,
      accountId,
    );
  } finally {
    await Promise.all([
      removeRule(options.declarativeNetRequest, bridge.ruleId),
      transactionStore.delete(CODEX_EXPERIMENTAL_CONFIGURATION.providerId),
    ]);
  }
}
