import {
  PLUGIN_API_VERSION,
  agentKey,
  definePlugin,
  registerAgent,
  type LoomPlugin,
} from '@mgravey/loom-plugin-api';
import { capabilityId, pluginId, semanticVersion } from '@mgravey/loom-types';

import {
  CODEX_AGENT_FACTORY,
  type CodexAgentDependencies,
  type CodexAgentRequest,
} from './agent.js';
import type { CodexAgentEvent } from './protocol.js';

export const CODEX_AGENT_PLUGIN_ID = pluginId('loom/agent-codex');
export const CODEX_AGENT_CAPABILITY_ID = capabilityId('loom/codex-agent');
export const CODEX_AGENT_KEY = agentKey<CodexAgentRequest, CodexAgentEvent, CodexAgentDependencies>(
  CODEX_AGENT_CAPABILITY_ID,
);

export function createCodexAgentPlugin(): LoomPlugin {
  return definePlugin({
    manifest: {
      id: CODEX_AGENT_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
    },
    initialize(context) {
      registerAgent<CodexAgentRequest, CodexAgentEvent, CodexAgentDependencies>(
        context.capabilities,
        CODEX_AGENT_CAPABILITY_ID,
        CODEX_AGENT_FACTORY,
      );
    },
  });
}
