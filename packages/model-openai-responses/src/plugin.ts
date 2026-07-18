import type { CodexModelEvent, CodexModelRequest } from '@loom/agent-codex';
import {
  PLUGIN_API_VERSION,
  definePlugin,
  modelKey,
  registerModel,
  type LoomPlugin,
} from '@loom/plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@loom/types';

import type { CreateOpenAIResponsesModelOptions } from './contracts.js';
import { createOpenAIResponsesModel } from './model.js';

export const OPENAI_RESPONSES_MODEL_PLUGIN_ID = pluginId('loom/model-openai-responses');
export const OPENAI_RESPONSES_MODEL_CAPABILITY_ID = capabilityId('loom/openai-responses-model');
export const OPENAI_RESPONSES_MODEL_KEY = modelKey<CodexModelRequest, CodexModelEvent>(
  OPENAI_RESPONSES_MODEL_CAPABILITY_ID,
);

export function createOpenAIResponsesModelPlugin(
  options: CreateOpenAIResponsesModelOptions,
): LoomPlugin {
  const model = createOpenAIResponsesModel(options);
  return definePlugin({
    manifest: {
      id: OPENAI_RESPONSES_MODEL_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerModel(context.capabilities, OPENAI_RESPONSES_MODEL_CAPABILITY_ID, model);
    },
  });
}
