import { credentialProviderId } from '@loom/credential-broker-api';

import type { ChromeExtensionApi } from './chrome-contracts.js';
import {
  createChromeExternalMessageListener,
  createCredentialBrokerMessageHandler,
} from './message-handler.js';
import { createMockCredentialProvider } from './mock-provider.js';
import { createOriginAuthorizer } from './origins.js';
import {
  createChromeRefreshCredentialStore,
  initializeTrustedCredentialStorage,
} from './storage.js';
import { createExtensionTokenService } from './token-service.js';

const chromeApi = (globalThis as unknown as { readonly chrome: ChromeExtensionApi }).chrome;
const providerId = credentialProviderId('loom/mock');
const credentialStore = createChromeRefreshCredentialStore(chromeApi.storage.local);
const provider = createMockCredentialProvider({ id: providerId });
const ready = initializeTrustedCredentialStorage(chromeApi.storage.local, async () => {
  const credential = await credentialStore.get(providerId);
  if (credential === undefined) {
    await credentialStore.set(providerId, { value: 'development-only-mock-credential' });
  }
});
const initializedStore = {
  async get(id: string) {
    await ready;
    return credentialStore.get(id);
  },
  set: (id: string, credential: { readonly value: string }) => credentialStore.set(id, credential),
  delete: (id: string) => credentialStore.delete(id),
};
const tokenService = createExtensionTokenService({
  providers: [provider],
  credentialStore: initializedStore,
});
const handler = createCredentialBrokerMessageHandler({
  authorizer: createOriginAuthorizer(['http://localhost:4173', 'http://127.0.0.1:4173']),
  tokenService,
});

chromeApi.runtime.onMessageExternal.addListener(createChromeExternalMessageListener(handler));
