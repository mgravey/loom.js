import { CAPABILITY_KINDS, createCapabilityKey, type Platform } from '@mgravey/loom-plugin-api';
import { capabilityId, pluginId } from '@mgravey/loom-types';

export type BrowserExecutionScope = 'window' | 'dedicated-worker';

/**
 * Browser primitives explicitly supplied by the embedding application.
 * The descriptor is immutable; the host-owned IDBFactory remains stateful.
 */
export interface BrowserPlatform extends Platform {
  readonly scope: BrowserExecutionScope;
  readonly indexedDB: IDBFactory;
}

export interface CreateBrowserPlatformPluginOptions {
  readonly scope: BrowserExecutionScope;
  readonly indexedDB: IDBFactory;
}

export const BROWSER_PLATFORM_PLUGIN_ID = pluginId('loom/browser-platform');
export const BROWSER_PLATFORM_CAPABILITY_ID = capabilityId('loom/browser-platform');
export const BROWSER_PLATFORM_KEY = createCapabilityKey<BrowserPlatform>(
  CAPABILITY_KINDS.platform,
  BROWSER_PLATFORM_CAPABILITY_ID,
);
