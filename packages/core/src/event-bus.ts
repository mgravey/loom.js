import type { EventBus, EventHandler, EventKey } from '@loom/plugin-api';

import { assertNonEmpty, type Awaitable } from './internal.js';

export interface EventHandlerErrorContext {
  readonly event: Readonly<{ readonly id: string }>;
  readonly payload: unknown;
  readonly handlerIndex: number;
}

export type EventErrorSink = (error: unknown, context: EventHandlerErrorContext) => Awaitable<void>;

export interface EventBusController extends EventBus {
  clear(): void;
}

/**
 * Creates an isolated event bus. Handlers are awaited serially in subscription
 * order; a handler or error-sink failure never prevents remaining handlers.
 */
export function createEventBus(errorSink: EventErrorSink = () => undefined): EventBusController {
  const handlers = new Map<string, EventHandler<unknown>[]>();

  return Object.freeze({
    on<T>(event: EventKey<T>, handler: EventHandler<T>): () => void {
      assertNonEmpty(event.id, 'Event id');
      const eventHandlers = handlers.get(event.id) ?? [];
      if (!handlers.has(event.id)) handlers.set(event.id, eventHandlers);
      eventHandlers.push(handler as EventHandler<unknown>);

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        const current = handlers.get(event.id);
        if (current === undefined) return;
        const index = current.indexOf(handler as EventHandler<unknown>);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(event.id);
      };
    },

    async emit<T>(event: EventKey<T>, payload: T): Promise<void> {
      assertNonEmpty(event.id, 'Event id');
      const snapshot = [...(handlers.get(event.id) ?? [])];
      for (let index = 0; index < snapshot.length; index += 1) {
        const handler = snapshot[index];
        if (handler === undefined) continue;
        try {
          await handler(payload);
        } catch (error) {
          const context = Object.freeze({ event, payload, handlerIndex: index });
          try {
            await errorSink(error, context);
          } catch {
            // Error reporting must not change event delivery semantics.
          }
        }
      }
    },

    clear(): void {
      handlers.clear();
    },
  });
}
