import { createCodexExperimentalExtension } from './composition.js';
import type { CodexChromeExtensionApi, CodexModelFetch, OAuthFetch } from './chrome-contracts.js';
import { createCodexModelPortListener } from './model-transport.js';

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly fetch: OAuthFetch & CodexModelFetch;
};
const fetchRequest = host.fetch.bind(globalThis);
const composition = createCodexExperimentalExtension({
  chromeApi: host.chrome,
  fetchRequest,
});

host.chrome.runtime.onMessageExternal.addListener(composition.externalMessageListener);
host.chrome.runtime.onConnectExternal.addListener(
  createCodexModelPortListener({
    providerId: composition.providerId,
    tokenService: composition.tokenService,
    accountRoutingStore: composition.accountRoutingStore,
    fetchRequest,
  }),
);
