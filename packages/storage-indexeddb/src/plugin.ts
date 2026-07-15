import { PLUGIN_API_VERSION, definePlugin, storageKey, type LoomPlugin } from '@loom/plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@loom/types';

import { createIndexedDbStorage, type CreateIndexedDbStorageOptions } from './storage.js';

export const INDEXEDDB_STORAGE_PLUGIN_ID = pluginId('loom/storage-indexeddb');
export const INDEXEDDB_STORAGE_CAPABILITY_ID = capabilityId('loom/indexeddb-storage');
export const INDEXEDDB_STORAGE_KEY = storageKey(INDEXEDDB_STORAGE_CAPABILITY_ID);

export type CreateIndexedDbStoragePluginOptions = CreateIndexedDbStorageOptions;

export function createIndexedDbStoragePlugin(
  options: CreateIndexedDbStoragePluginOptions,
): LoomPlugin {
  const storage = createIndexedDbStorage(options);
  return definePlugin({
    manifest: {
      id: INDEXEDDB_STORAGE_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      context.capabilities.register(INDEXEDDB_STORAGE_KEY, storage);
    },
    dispose: () => storage.dispose(),
  });
}
