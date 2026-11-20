import type { CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import {
  PLUGIN_API_VERSION,
  definePlugin,
  modelKey,
  registerModel,
  type LoomPlugin,
} from '@mgravey/loom-plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@mgravey/loom-types';

import type { AnthropicMessagesModelOptions } from './contracts.js';
import { createAnthropicMessagesModel } from './model.js';

export const ANTHROPIC_MESSAGES_MODEL_PLUGIN_ID = pluginId('loom/model-anthropic-messages');
export const ANTHROPIC_MESSAGES_MODEL_CAPABILITY_ID = capabilityId('loom/anthropic-messages-model');
export const ANTHROPIC_MESSAGES_MODEL_KEY = modelKey<CodexModelRequest, CodexModelEvent>(
  ANTHROPIC_MESSAGES_MODEL_CAPABILITY_ID,
);

export function createAnthropicMessagesModelPlugin(
  options: AnthropicMessagesModelOptions,
): LoomPlugin {
  const model = createAnthropicMessagesModel(options);
  return definePlugin({
    manifest: {
      id: ANTHROPIC_MESSAGES_MODEL_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerModel(context.capabilities, ANTHROPIC_MESSAGES_MODEL_CAPABILITY_ID, model);
    },
  });
}
