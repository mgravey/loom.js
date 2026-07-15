import type {
  Awaitable,
  Clock,
  DeepReadonly,
  JsonObject,
  PluginId,
  SemanticVersion,
} from '@loom/types';

import type { CapabilityRegistrar, CapabilityRegistryReader } from './capabilities.js';
import type { EventBus } from './events.js';
import type { ServiceRegistrar, ServiceResolver } from './services.js';

export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  readonly id: PluginId;
  readonly version: SemanticVersion;
  readonly apiVersion: number;
  readonly requiredPlugins?: readonly PluginId[];
  readonly optionalPlugins?: readonly PluginId[];
}

export interface PluginInitializeContext {
  readonly pluginId: PluginId;
  readonly configuration: DeepReadonly<JsonObject>;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly capabilities: CapabilityRegistryReader & CapabilityRegistrar;
  readonly services: ServiceResolver & ServiceRegistrar;
}

export interface PluginRuntimeContext {
  readonly pluginId: PluginId;
  readonly configuration: DeepReadonly<JsonObject>;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly capabilities: CapabilityRegistryReader;
  readonly services: ServiceResolver;
}

export type PluginStartContext = PluginRuntimeContext;
export type PluginStopContext = PluginRuntimeContext;
export type PluginDisposeContext = PluginRuntimeContext;

export interface LoomPlugin {
  readonly manifest: PluginManifest;
  initialize?(context: PluginInitializeContext): Awaitable<void>;
  start?(context: PluginStartContext): Awaitable<void>;
  stop?(context: PluginStopContext): Awaitable<void>;
  dispose?(context: PluginDisposeContext): Awaitable<void>;
}

/** Convenience helper that preserves a plugin object's inferred hook types. */
export function definePlugin<const Plugin extends LoomPlugin>(plugin: Plugin): Plugin {
  return plugin;
}
