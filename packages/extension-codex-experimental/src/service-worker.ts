import { createCodexExperimentalExtension } from './composition.js';
import type { CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly fetch: OAuthFetch;
};
const composition = createCodexExperimentalExtension({
  chromeApi: host.chrome,
  fetchRequest: host.fetch.bind(globalThis),
});

host.chrome.runtime.onMessageExternal.addListener(composition.externalMessageListener);
