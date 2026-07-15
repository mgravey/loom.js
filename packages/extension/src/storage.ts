import type { ChromeStorageArea } from './chrome-contracts.js';
import type { RefreshCredentialStore, StoredRefreshCredential } from './contracts.js';

const STORAGE_PREFIX = 'loom.refresh-credential.';

function storageKey(providerId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(providerId)}`;
}

export function restrictCredentialStorageToTrustedContexts(
  storage: ChromeStorageArea,
): Promise<void> {
  return storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function initializeTrustedCredentialStorage(
  storage: ChromeStorageArea,
  initialize: () => Promise<void>,
): Promise<void> {
  await restrictCredentialStorageToTrustedContexts(storage);
  await initialize();
}

export function createChromeRefreshCredentialStore(
  storage: ChromeStorageArea,
): RefreshCredentialStore {
  return {
    async get(providerId) {
      const key = storageKey(providerId);
      const result = await storage.get(key);
      const value = result[key];
      if (typeof value !== 'string' || value.length === 0) return undefined;
      return Object.freeze({ value });
    },
    async set(providerId, credential) {
      await storage.set({ [storageKey(providerId)]: credential.value });
    },
    async delete(providerId) {
      await storage.remove(storageKey(providerId));
    },
  };
}

export function createMemoryRefreshCredentialStore(
  initial: Readonly<Record<string, string>> = {},
): RefreshCredentialStore {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    get(providerId): Promise<StoredRefreshCredential | undefined> {
      const value = entries.get(providerId);
      return Promise.resolve(value === undefined ? undefined : Object.freeze({ value }));
    },
    set(providerId, credential): Promise<void> {
      entries.set(providerId, credential.value);
      return Promise.resolve();
    },
    delete(providerId): Promise<void> {
      entries.delete(providerId);
      return Promise.resolve();
    },
  };
}
