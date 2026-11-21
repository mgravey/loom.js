import { vi } from 'vitest';
import { messageSenderOrigin, type ChromeMessageSender } from '@mgravey/loom-extension';

import {
  CHATGPT_HELPER_CALLBACK_PROTOCOL,
  CHATGPT_HELPER_ENABLED_KEY,
  CHATGPT_HELPER_VERSION,
  createChatGPTHelper,
  type ChatGPTHelperChromeApi,
  type ChatGPTHelperFetch,
} from '../src/chatgpt-helper.js';
import type {
  ChromeDeclarativeNetRequestRule,
  CodexExternalPort,
} from '../src/chrome-contracts.js';

export const EXTENSION_ID = 'helperextensionid';

interface FakePort {
  readonly name: string;
  readonly sender?: ChromeMessageSender;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

/** Two connected ports with asynchronous, serialized delivery, like Chrome's messaging. */
function portPair(name: string, sender: ChromeMessageSender) {
  const make = (portSender?: ChromeMessageSender) => {
    const messageListeners = new Set<(message: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
    return { messageListeners, disconnectListeners, sender: portSender };
  };
  const page = make();
  const extension = make(sender);
  let connected = true;
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): FakePort => ({
    name,
    ...(self.sender === undefined ? {} : { sender: self.sender }),
    onMessage: {
      addListener: (listener) => self.messageListeners.add(listener),
      removeListener: (listener) => self.messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => self.disconnectListeners.add(listener),
      removeListener: (listener) => self.disconnectListeners.delete(listener),
    },
    postMessage(message) {
      if (!connected) throw new Error('Attempting to use a disconnected port object');
      const copy: unknown = structuredClone(message);
      setTimeout(() => {
        if (connected) other.messageListeners.forEach((listener) => listener(copy));
      }, 0);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      setTimeout(() => other.disconnectListeners.forEach((listener) => listener()), 0);
    },
  });
  return {
    page: side(page, extension),
    extension: side(extension, page),
    isConnected: () => connected,
  };
}

function storageArea(values: Map<string, unknown>) {
  return {
    setAccessLevel: vi.fn(() => Promise.resolve()),
    get: vi.fn((key: string) => Promise.resolve(values.has(key) ? { [key]: values.get(key) } : {})),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
}

export function createHelperFixture() {
  const values = new Map<string, unknown>([[CHATGPT_HELPER_ENABLED_KEY, true]]);
  const approved = new Set<string>();
  const permissions = { granted: true };
  const rules = new Map<number, ChromeDeclarativeNetRequestRule>();
  const windows = new Map<number, number>();
  const tabUrls = new Map<number, string>();
  const removedListeners = new Set<(tabId: number) => void>();
  const ports: ReturnType<typeof portPair>[] = [];
  let nextWindow = 0;
  const chromeApi: ChatGPTHelperChromeApi = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
    windows: {
      create: vi.fn(() => {
        nextWindow += 1;
        const tabId = 100 + nextWindow;
        windows.set(nextWindow, tabId);
        return Promise.resolve({ id: nextWindow, tabs: [{ id: tabId }] });
      }),
      remove: vi.fn((windowId: number) => {
        const tabId = windows.get(windowId);
        windows.delete(windowId);
        if (tabId !== undefined) removedListeners.forEach((listener) => listener(tabId));
        return Promise.resolve();
      }),
    },
    tabs: {
      update: vi.fn((tabId: number, options: { readonly url: string }) => {
        tabUrls.set(tabId, options.url);
        return Promise.resolve({});
      }),
      onRemoved: {
        addListener: (listener) => removedListeners.add(listener),
        removeListener: (listener) => removedListeners.delete(listener),
      },
    },
    declarativeNetRequest: {
      updateSessionRules: vi.fn(
        (update: {
          readonly removeRuleIds?: readonly number[];
          readonly addRules?: readonly ChromeDeclarativeNetRequestRule[];
        }) => {
          update.removeRuleIds?.forEach((id) => rules.delete(id));
          update.addRules?.forEach((rule) => rules.set(rule.id, rule));
          return Promise.resolve();
        },
      ),
    },
    permissions: { contains: vi.fn(() => Promise.resolve(permissions.granted)) },
    storage: { local: storageArea(values) },
  };
  const upstream = vi.fn<ChatGPTHelperFetch>(() => Promise.reject(new Error('No upstream')));
  const manifestAuthorizer = {
    assertAuthorized(sender: ChromeMessageSender) {
      const origin = messageSenderOrigin(sender);
      if (origin === undefined || !origin.startsWith('https://'))
        throw new Error('manifest denied');
    },
  };
  const helper = createChatGPTHelper({
    chromeApi,
    fetch: upstream,
    manifestAuthorizer,
    authorizer: {
      assertAuthorized(sender: ChromeMessageSender) {
        manifestAuthorizer.assertAuthorized(sender);
        const origin = messageSenderOrigin(sender);
        if (origin === undefined || !approved.has(origin)) return Promise.reject(new Error('no'));
        return Promise.resolve();
      },
    },
  });

  /** The page-side `chrome.runtime` as seen by a website at `origin`. */
  const runtimeFor = (origin: string) => ({
    sendMessage(
      _extensionId: string,
      message: unknown,
      _options: undefined,
      callback: (response: unknown) => void,
    ) {
      helper.externalMessageListener(
        structuredClone(message),
        { origin, url: `${origin}/app` },
        (response) => setTimeout(() => callback(structuredClone(response)), 0),
      );
    },
    connect(_extensionId: string, options: { readonly name: string }) {
      const pair = portPair(options.name, { origin, url: `${origin}/app` });
      ports.push(pair);
      setTimeout(() => helper.portListener(pair.extension as CodexExternalPort), 0);
      return pair.page;
    },
  });

  /**
   * Simulates Chrome navigating sign-in tab `tabId` to `url`: applies the tab-scoped DNR rule, and
   * when it redirects to the callback page, runs that page's message to the service worker.
   */
  const navigate = async (tabId: number, url: string) => {
    for (const rule of rules.values()) {
      if (!rule.condition.tabIds.includes(tabId)) continue;
      const match = new RegExp(rule.condition.regexFilter, 'u').exec(url);
      if (match === null) continue;
      const redirected = rule.action.redirect.regexSubstitution.replace('\\1', match[1] ?? '');
      const target = new URL(redirected);
      return new Promise<{ readonly redirected: string; readonly response: unknown }>((resolve) => {
        helper.callbackMessageListener(
          {
            protocol: CHATGPT_HELPER_CALLBACK_PROTOCOL,
            version: CHATGPT_HELPER_VERSION,
            search: target.search,
          },
          { id: EXTENSION_ID, url: redirected, tab: { id: tabId } },
          (response) => resolve({ redirected, response }),
        );
      });
    }
    return { redirected: url, response: undefined };
  };

  return {
    helper,
    chromeApi,
    values,
    approved,
    permissions,
    rules,
    windows,
    tabUrls,
    ports,
    upstream,
    runtimeFor,
    navigate,
  };
}

export type HelperFixture = ReturnType<typeof createHelperFixture>;
