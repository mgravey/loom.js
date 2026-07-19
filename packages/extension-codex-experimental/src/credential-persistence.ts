import {
  createChromeRefreshCredentialStore,
  initializeTrustedCredentialStorage,
  type ChromeStorageArea,
  type RefreshCredentialStore,
  type StoredRefreshCredential,
} from '@loom/extension';

import {
  createCodexAccountRoutingStore,
  type CodexAccountRoutingStore,
} from './account-routing.js';
import type { CodexCredentialPersistenceMode, CodexExperimentSettings } from './settings.js';

export interface CodexStoredAuthorization {
  readonly credential: StoredRefreshCredential;
  readonly accountId: string;
}

export interface CodexCredentialPersistence {
  readonly credentialStore: RefreshCredentialStore;
  readonly accountRoutingStore: CodexAccountRoutingStore;
  initialize(): Promise<void>;
  getAuthorization(): Promise<CodexStoredAuthorization | undefined>;
  saveAuthorization(
    providerId: string,
    credential: StoredRefreshCredential,
    accountId: string,
  ): Promise<void>;
  setMode(mode: CodexCredentialPersistenceMode): Promise<void>;
  clearAll(providerId: string): Promise<void>;
}

interface Stores {
  readonly credentials: RefreshCredentialStore;
  readonly routing: CodexAccountRoutingStore;
}

interface StoreState {
  readonly authorization?: CodexStoredAuthorization;
  readonly incomplete: boolean;
}

function otherMode(mode: CodexCredentialPersistenceMode): CodexCredentialPersistenceMode {
  return mode === 'session' ? 'local' : 'session';
}

async function readState(stores: Stores, providerId: string): Promise<StoreState> {
  const [credential, accountId] = await Promise.all([
    stores.credentials.get(providerId),
    stores.routing.get(),
  ]);
  if (credential !== undefined && accountId !== undefined) {
    return Object.freeze({
      authorization: Object.freeze({ credential, accountId }),
      incomplete: false,
    });
  }
  return Object.freeze({
    incomplete: credential !== undefined || accountId !== undefined,
  });
}

async function clear(stores: Stores, providerId: string): Promise<void> {
  await Promise.all([stores.credentials.delete(providerId), stores.routing.delete()]);
}

async function write(
  stores: Stores,
  providerId: string,
  authorization: CodexStoredAuthorization,
): Promise<void> {
  await clear(stores, providerId);
  await stores.routing.set(authorization.accountId);
  try {
    await stores.credentials.set(providerId, authorization.credential);
  } catch (error) {
    await clear(stores, providerId);
    throw error;
  }
}

export function createCodexCredentialPersistence(options: {
  readonly settings: CodexExperimentSettings;
  readonly localStorage: ChromeStorageArea;
  readonly sessionStorage: ChromeStorageArea;
  readonly providerId: string;
}): CodexCredentialPersistence {
  const stores: Readonly<Record<CodexCredentialPersistenceMode, Stores>> = Object.freeze({
    local: Object.freeze({
      credentials: createChromeRefreshCredentialStore(options.localStorage),
      routing: createCodexAccountRoutingStore(options.localStorage),
    }),
    session: Object.freeze({
      credentials: createChromeRefreshCredentialStore(options.sessionStorage),
      routing: createCodexAccountRoutingStore(options.sessionStorage),
    }),
  });
  const ready = Promise.all([
    initializeTrustedCredentialStorage(options.localStorage, () => Promise.resolve()),
    initializeTrustedCredentialStorage(options.sessionStorage, () => Promise.resolve()),
  ]).then(() => undefined);

  async function activeMode(): Promise<CodexCredentialPersistenceMode> {
    await ready;
    return options.settings.getCredentialPersistenceMode();
  }

  async function reconcile(): Promise<void> {
    const mode = await activeMode();
    const inactiveMode = otherMode(mode);
    const [active, inactive] = await Promise.all([
      readState(stores[mode], options.providerId),
      readState(stores[inactiveMode], options.providerId),
    ]);
    if (active.incomplete) await clear(stores[mode], options.providerId);
    if (inactive.incomplete || inactive.authorization !== undefined) {
      await clear(stores[inactiveMode], options.providerId);
    }
  }

  const credentialStore: RefreshCredentialStore = Object.freeze({
    async get(providerId: string) {
      const mode = await activeMode();
      return stores[mode].credentials.get(providerId);
    },
    async set(providerId: string, credential: StoredRefreshCredential) {
      const mode = await activeMode();
      await stores[mode].credentials.set(providerId, credential);
      await stores[otherMode(mode)].credentials.delete(providerId);
    },
    async delete(providerId: string) {
      await ready;
      await Promise.all([
        stores.session.credentials.delete(providerId),
        stores.local.credentials.delete(providerId),
      ]);
    },
  });

  const accountRoutingStore: CodexAccountRoutingStore = Object.freeze({
    async get() {
      const mode = await activeMode();
      return stores[mode].routing.get();
    },
    async set(accountId: string) {
      const mode = await activeMode();
      await stores[mode].routing.set(accountId);
      await stores[otherMode(mode)].routing.delete();
    },
    async delete() {
      await ready;
      await Promise.all([stores.session.routing.delete(), stores.local.routing.delete()]);
    },
  });

  return Object.freeze({
    credentialStore,
    accountRoutingStore,
    async initialize() {
      await ready;
      await reconcile();
    },
    async getAuthorization() {
      const mode = await activeMode();
      return (await readState(stores[mode], options.providerId)).authorization;
    },
    async saveAuthorization(
      providerId: string,
      credential: StoredRefreshCredential,
      accountId: string,
    ) {
      const mode = await activeMode();
      await write(stores[mode], providerId, Object.freeze({ credential, accountId }));
      await clear(stores[otherMode(mode)], providerId);
    },
    async setMode(mode: CodexCredentialPersistenceMode) {
      await ready;
      const currentMode = await options.settings.getCredentialPersistenceMode();
      if (mode === currentMode) {
        await reconcile();
        return;
      }
      const source = await readState(stores[currentMode], options.providerId);
      await clear(stores[mode], options.providerId);
      if (source.incomplete) {
        await clear(stores[currentMode], options.providerId);
      } else if (source.authorization !== undefined) {
        await write(stores[mode], options.providerId, source.authorization);
      }
      try {
        await options.settings.setCredentialPersistenceMode(mode);
      } catch (error) {
        await clear(stores[mode], options.providerId);
        throw error;
      }
      await clear(stores[currentMode], options.providerId);
    },
    async clearAll(providerId: string) {
      await ready;
      await Promise.all([clear(stores.session, providerId), clear(stores.local, providerId)]);
    },
  });
}
