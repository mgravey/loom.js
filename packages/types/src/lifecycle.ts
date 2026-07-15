import type { DeepReadonly, JsonObject } from './json.js';
import type { SessionId } from './ids.js';

export type RuntimeState =
  'created' | 'initialized' | 'running' | 'stopped' | 'disposed' | 'failed';

export type PluginState =
  | 'registered'
  | 'initializing'
  | 'initialized'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'disposing'
  | 'disposed'
  | 'failed';

export interface SessionMetadata {
  readonly id: SessionId;
  readonly createdAt: number;
  readonly attributes: JsonObject;
}

/** Plugin-ID-keyed JSON. Implementations validate each string as a PluginId. */
export type RuntimeConfiguration = Readonly<Record<string, DeepReadonly<JsonObject>>>;

export type SessionConfigurationOverlay = RuntimeConfiguration;
