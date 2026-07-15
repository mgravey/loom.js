import type {
  CancellationSignal,
  Clock,
  DeepReadonly,
  JsonObject,
  PluginId,
  RuntimeConfiguration,
  RuntimeState,
  SessionConfigurationOverlay,
  SessionId,
  SessionMetadata,
} from '@loom/types';

import type { CapabilityRegistryReader } from './capabilities.js';
import type { ErrorSink, EventBus } from './events.js';
import type { LoomPlugin } from './plugin.js';
import type { ServiceResolver, ServiceScope } from './services.js';

export interface CreateSessionOptions {
  readonly id: SessionId;
  readonly attributes?: JsonObject;
  readonly configuration?: SessionConfigurationOverlay;
}

export interface LoomSession {
  readonly metadata: SessionMetadata;
  readonly configuration: DeepReadonly<RuntimeConfiguration>;
  readonly signal: CancellationSignal;
  readonly events: EventBus;
  readonly services: ServiceScope;
  readonly capabilities: CapabilityRegistryReader;
  close(reason?: unknown): Promise<void>;
}

export interface SessionManager {
  create(options: CreateSessionOptions): Promise<LoomSession>;
  get(id: SessionId): LoomSession;
  tryGet(id: SessionId): LoomSession | undefined;
  list(): readonly LoomSession[];
  close(id: SessionId, reason?: unknown): Promise<void>;
}

export interface LoomRuntime {
  readonly state: RuntimeState;
  readonly capabilities: CapabilityRegistryReader;
  readonly services: ServiceResolver;
  readonly events: EventBus;
  readonly sessions: SessionManager;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateLoomRuntimeOptions {
  readonly plugins: readonly LoomPlugin[];
  readonly configuration?: RuntimeConfiguration;
  readonly clock?: Clock;
  readonly errorSink?: ErrorSink;
}

/** Runtime factory shape implemented by `@loom/core`. */
export type LoomRuntimeFactory = (options: CreateLoomRuntimeOptions) => LoomRuntime;

/** The owning plugin sees only its immutable configuration object. */
export interface PluginConfigurationReader {
  get(pluginId: PluginId): DeepReadonly<JsonObject>;
}
