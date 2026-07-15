import type {
  CapabilityId,
  EventId,
  PluginId,
  PluginState,
  RuntimeState,
  SessionId,
  SessionMetadata,
} from '@loom/types';
import { eventId } from '@loom/types';

export interface EventKey<Event> {
  readonly id: EventId;
  readonly __event?: (value: Event) => Event;
}

export function createEventKey<Event>(id: string | EventId): EventKey<Event> {
  return Object.freeze({ id: eventId(id) });
}

export type EventHandler<Event> = (event: Event) => void | Promise<void>;

export interface EventBus {
  on<Event>(key: EventKey<Event>, handler: EventHandler<Event>): () => void;
  emit<Event>(key: EventKey<Event>, event: Event): Promise<void>;
}

export type ErrorSink = (error: unknown) => void;

export interface RuntimeStateEvent {
  readonly previous: RuntimeState;
  readonly current: RuntimeState;
  readonly timestamp: number;
}

export interface PluginStateEvent {
  readonly pluginId: PluginId;
  readonly previous: PluginState;
  readonly current: PluginState;
  readonly timestamp: number;
}

export interface CapabilityRegistrationEvent {
  readonly owner: PluginId;
  readonly kind: string;
  readonly capabilityId: CapabilityId;
  readonly action: 'registered' | 'removed';
  readonly timestamp: number;
}

export interface SessionEvent {
  readonly sessionId: SessionId;
  readonly metadata: SessionMetadata;
  readonly action: 'created' | 'closed';
  readonly timestamp: number;
}

export const RUNTIME_STATE_EVENT = createEventKey<RuntimeStateEvent>('loom/runtime-state');
export const PLUGIN_STATE_EVENT = createEventKey<PluginStateEvent>('loom/plugin-state');
export const CAPABILITY_REGISTRATION_EVENT = createEventKey<CapabilityRegistrationEvent>(
  'loom/capability-registration',
);
export const SESSION_EVENT = createEventKey<SessionEvent>('loom/session');
