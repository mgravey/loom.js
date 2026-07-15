import { PLUGIN_API_VERSION, definePlugin, type LoomPlugin } from '@loom/plugin-api';
import { semanticVersion } from '@loom/types';

import {
  BROWSER_PLATFORM_KEY,
  BROWSER_PLATFORM_PLUGIN_ID,
  type BrowserPlatform,
  type CreateBrowserPlatformPluginOptions,
} from './contracts.js';

function assertOptions(options: unknown): asserts options is CreateBrowserPlatformPluginOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Browser platform options are required.');
  }
  if (
    !('scope' in options) ||
    (options.scope !== 'window' && options.scope !== 'dedicated-worker')
  ) {
    const scope = 'scope' in options ? options.scope : undefined;
    throw new TypeError(`Invalid browser execution scope "${String(scope)}".`);
  }
  if (
    !('indexedDB' in options) ||
    options.indexedDB === null ||
    typeof options.indexedDB !== 'object'
  ) {
    throw new TypeError('An explicit IDBFactory is required.');
  }
}

export function createBrowserPlatformPlugin(
  options: CreateBrowserPlatformPluginOptions,
): LoomPlugin {
  assertOptions(options);
  const platform: BrowserPlatform = Object.freeze({
    scope: options.scope,
    indexedDB: options.indexedDB,
  });

  return definePlugin({
    manifest: {
      id: BROWSER_PLATFORM_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      context.capabilities.register(BROWSER_PLATFORM_KEY, platform);
    },
  });
}
