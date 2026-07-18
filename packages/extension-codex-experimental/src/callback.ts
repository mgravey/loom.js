import {
  createChromeRefreshCredentialStore,
  initializeTrustedCredentialStorage,
} from '@loom/extension';

import { createCodexAccountRoutingStore } from './account-routing.js';
import {
  completeBrowserAuthorization,
  createBrowserAuthorizationBridgeStore,
} from './browser-authorization.js';
import type { BrowserCrypto, CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';
import { createCodexExperimentSettings } from './settings.js';

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly crypto: BrowserCrypto;
  readonly document: Document;
  readonly fetch: OAuthFetch;
  readonly location: Location;
};

const status = host.document.querySelector('#status');
if (!(status instanceof HTMLElement)) throw new Error('Callback page is missing its status.');

const settings = createCodexExperimentSettings(host.chrome.storage.local);
const storage = host.chrome.storage.session;
const credentialStore = createChromeRefreshCredentialStore(storage);
const accountRoutingStore = createCodexAccountRoutingStore(storage);
const bridgeStore = createBrowserAuthorizationBridgeStore(host.chrome.storage.session);

void initializeTrustedCredentialStorage(storage, () => Promise.resolve())
  .then(() =>
    completeBrowserAuthorization({
      settings,
      credentialStore,
      accountRoutingStore,
      transactionStorage: host.chrome.storage.session,
      bridgeStore,
      declarativeNetRequest: host.chrome.declarativeNetRequest,
      tabs: host.chrome.tabs,
      fetchRequest: host.fetch.bind(globalThis),
      cryptoApi: host.crypto,
      callbackSearch: host.location.search,
    }),
  )
  .then(() => {
    status.textContent = 'ChatGPT sign-in is complete. You can close this tab.';
    status.className = 'success';
  })
  .catch(() => {
    status.textContent =
      'ChatGPT sign-in did not complete. Return to the extension options and try again.';
    status.className = 'error';
  });
