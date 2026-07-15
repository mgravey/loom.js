import {
  PLUGIN_API_VERSION,
  authKey,
  definePlugin,
  registerAuth,
  type LoomPlugin,
} from '@loom/plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@loom/types';

import {
  createExtensionAuthProvider,
  type CreateExtensionAuthProviderOptions,
} from './provider.js';

export const EXTENSION_AUTH_PLUGIN_ID = pluginId('loom/auth-extension');
export const EXTENSION_AUTH_CAPABILITY_ID = capabilityId('loom/extension-auth');
export const EXTENSION_AUTH_KEY = authKey(EXTENSION_AUTH_CAPABILITY_ID);

export type CreateExtensionAuthPluginOptions = CreateExtensionAuthProviderOptions;

export function createExtensionAuthPlugin(options: CreateExtensionAuthPluginOptions): LoomPlugin {
  const provider = createExtensionAuthProvider(options);
  return definePlugin({
    manifest: {
      id: EXTENSION_AUTH_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerAuth(context.capabilities, EXTENSION_AUTH_CAPABILITY_ID, provider);
    },
  });
}
