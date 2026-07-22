import {
  SESSION_EVENT,
  type CapabilityRegistryReader,
  type CreateSessionOptions,
  type ErrorSink,
  type LoomSession,
  type SessionManager,
} from '@mgravey/loom-plugin-api';
import {
  LoomAggregateError,
  LoomError,
  createCancellationSource,
  immutableJson,
  type Clock,
  type JsonObject,
  type SessionId,
} from '@mgravey/loom-types';

import type { ConfigurationStore } from './configuration.js';
import { createEventBus } from './event-bus.js';
import type { ServiceContainerController } from './service-container.js';

export interface SessionManagerController {
  readonly public: SessionManager;
  closeAll(reason?: unknown): Promise<void>;
}

export interface CreateSessionManagerOptions {
  readonly clock: Clock;
  readonly errorSink: ErrorSink;
  readonly configuration: ConfigurationStore;
  readonly capabilities: CapabilityRegistryReader;
  readonly services: ServiceContainerController;
  readonly runtimeEvents: ReturnType<typeof createEventBus>;
  readonly isRunning: () => boolean;
}

/** Creates the runtime-owned collection of isolated in-memory session scopes. */
export function createSessionManager(
  options: CreateSessionManagerOptions,
): SessionManagerController {
  interface SessionRecord {
    readonly session: LoomSession;
    readonly cancel: (reason?: unknown) => void;
    readonly clearEvents: () => void;
  }

  const sessions = new Map<SessionId, SessionRecord>();
  const creationOrder: SessionId[] = [];
  const closing = new Map<SessionId, Promise<void>>();

  async function closeSession(id: SessionId, reason?: unknown): Promise<void> {
    const activeClose = closing.get(id);
    if (activeClose !== undefined) return activeClose;
    const record = sessions.get(id);
    if (record === undefined) return;
    const { session } = record;

    const operation = (async () => {
      const errors: unknown[] = [];
      record.cancel(reason);
      try {
        await session.services.dispose();
      } catch (error) {
        errors.push(error);
      }
      record.clearEvents();
      sessions.delete(id);
      const index = creationOrder.indexOf(id);
      if (index >= 0) creationOrder.splice(index, 1);
      await options.runtimeEvents.emit(
        SESSION_EVENT,
        Object.freeze({
          sessionId: id,
          metadata: session.metadata,
          action: 'closed' as const,
          timestamp: options.clock.now(),
        }),
      );
      if (errors.length > 0) {
        throw new LoomAggregateError(
          'CLEANUP_FAILED',
          `Session '${id}' closed with ${String(errors.length)} cleanup failure(s).`,
          errors,
        );
      }
    })();
    closing.set(id, operation);
    try {
      await operation;
    } finally {
      closing.delete(id);
    }
  }

  const manager: SessionManager = Object.freeze({
    async create(createOptions: CreateSessionOptions): Promise<LoomSession> {
      if (!options.isRunning()) {
        throw new LoomError(
          'INVALID_LIFECYCLE_TRANSITION',
          'Sessions can only be created while the runtime is running.',
        );
      }
      if (sessions.has(createOptions.id) || closing.has(createOptions.id)) {
        throw new LoomError('DUPLICATE_SESSION', `Session '${createOptions.id}' already exists.`, {
          details: { sessionId: createOptions.id },
        });
      }

      const attributes = immutableJson(createOptions.attributes ?? {}) as JsonObject;
      const metadata = Object.freeze({
        id: createOptions.id,
        createdAt: options.clock.now(),
        attributes,
      });
      const configuration = options.configuration.createOverlay(createOptions.configuration ?? {});
      const cancellation = createCancellationSource();
      const events = createEventBus(options.errorSink);
      const scope = options.services.createSessionScope();

      const session: LoomSession = Object.freeze({
        metadata,
        configuration: configuration.snapshot(),
        signal: cancellation.signal,
        events,
        services: scope,
        capabilities: options.capabilities,
        close: (reason?: unknown) => closeSession(createOptions.id, reason),
      });
      sessions.set(createOptions.id, {
        session,
        cancel: (reason?: unknown) => cancellation.cancel(reason),
        clearEvents: () => events.clear(),
      });
      creationOrder.push(createOptions.id);
      await options.runtimeEvents.emit(
        SESSION_EVENT,
        Object.freeze({
          sessionId: createOptions.id,
          metadata,
          action: 'created' as const,
          timestamp: options.clock.now(),
        }),
      );
      return session;
    },

    get(id: SessionId): LoomSession {
      const record = sessions.get(id);
      if (record === undefined) {
        throw new LoomError('MISSING_SESSION', `Session '${id}' does not exist.`, {
          details: { sessionId: id },
        });
      }
      return record.session;
    },

    tryGet(id: SessionId): LoomSession | undefined {
      return sessions.get(id)?.session;
    },

    list(): readonly LoomSession[] {
      return Object.freeze(
        creationOrder.flatMap((id) => {
          const record = sessions.get(id);
          return record === undefined ? [] : [record.session];
        }),
      );
    },

    close: closeSession,
  });

  return Object.freeze({
    public: manager,
    async closeAll(reason?: unknown): Promise<void> {
      const errors: unknown[] = [];
      for (const id of [...creationOrder].reverse()) {
        try {
          await closeSession(id, reason);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new LoomAggregateError(
          'CLEANUP_FAILED',
          `Session shutdown completed with ${String(errors.length)} failure(s).`,
          errors,
        );
      }
    },
  });
}
