import type { CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import {
  PLUGIN_API_VERSION,
  definePlugin,
  modelKey,
  registerModel,
  type LoomPlugin,
} from '@mgravey/loom-plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@mgravey/loom-types';

import type { CreateCodexExperimentalModelOptions } from './contracts.js';
import { createCodexExperimentalModel } from './model.js';

export const CODEX_EXPERIMENTAL_MODEL_PLUGIN_ID = pluginId('loom/model-codex-experimental');
export const CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID = capabilityId('loom/codex-model-experimental');
export const CODEX_EXPERIMENTAL_MODEL_KEY = modelKey<CodexModelRequest, CodexModelEvent>(
  CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID,
);

export function createCodexExperimentalModelPlugin(
  options: CreateCodexExperimentalModelOptions,
): LoomPlugin {
  const model = createCodexExperimentalModel(options);
  return definePlugin({
    manifest: {
      id: CODEX_EXPERIMENTAL_MODEL_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerModel(context.capabilities, CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID, model);
    },
  });
}
