import { createEventKey } from '@mgravey/loom-plugin-api';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../src/event-bus.js';

describe('event bus', () => {
  it('awaits handlers serially and continues after failures', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const event = createEventKey<number>('test/number');
    const bus = createEventBus((error, context) => {
      errors.push(error);
      calls.push(`error:${context.handlerIndex}`);
    });

    bus.on(event, async (value) => {
      await Promise.resolve();
      calls.push(`first:${value}`);
    });
    bus.on(event, () => {
      calls.push('second');
      throw new Error('handler failed');
    });
    bus.on(event, () => {
      calls.push('third');
    });

    await bus.emit(event, 7);

    expect(calls).toEqual(['first:7', 'second', 'error:1', 'third']);
    expect(errors).toHaveLength(1);
  });

  it('isolates buses and makes unsubscription idempotent', async () => {
    const event = createEventKey<undefined>('test/isolated');
    const first = createEventBus();
    const second = createEventBus();
    let count = 0;
    const unsubscribe = first.on(event, () => {
      count += 1;
    });

    await second.emit(event, undefined);
    unsubscribe();
    unsubscribe();
    await first.emit(event, undefined);
    expect(count).toBe(0);
  });

  it('attempts remaining handlers when the error sink also throws', async () => {
    const event = createEventKey<undefined>('test/sink-failure');
    const bus = createEventBus(() => {
      throw new Error('sink failed');
    });
    let delivered = false;
    bus.on(event, () => {
      throw new Error('event failed');
    });
    bus.on(event, () => {
      delivered = true;
    });

    await expect(bus.emit(event, undefined)).resolves.toBeUndefined();
    expect(delivered).toBe(true);
    bus.clear();
    await expect(bus.emit(event, undefined)).resolves.toBeUndefined();
  });
});
