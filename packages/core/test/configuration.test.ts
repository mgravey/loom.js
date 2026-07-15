import type { JsonObject } from '@loom/types';
import { describe, expect, it } from 'vitest';

import { createConfigurationStore } from '../src/configuration.js';

describe('configuration', () => {
  it('clones and deeply freezes values', () => {
    const input = { nested: { enabled: true }, values: [1, 2] };
    const store = createConfigurationStore({ 'test/plugin': input }, ['test/plugin', 'test/empty']);
    input.nested.enabled = false;
    input.values.push(3);

    const configuration = store.forPlugin('test/plugin').get();
    expect(configuration).toEqual({ nested: { enabled: true }, values: [1, 2] });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.nested)).toBe(true);
    expect(Object.isFrozen(configuration.values)).toBe(true);
    expect(store.forPlugin('test/empty').get()).toEqual({});
  });

  it('replaces only explicitly overridden plugin values', () => {
    const base = createConfigurationStore(
      { 'test/one': { source: 'runtime' }, 'test/two': { retained: true } },
      ['test/one', 'test/two'],
    );
    const session = base.createOverlay({ 'test/one': { source: 'session' } });

    expect(session.forPlugin('test/one').get()).toEqual({ source: 'session' });
    expect(session.forPlugin('test/two').get()).toEqual({ retained: true });
    expect(base.forPlugin('test/one').get()).toEqual({ source: 'runtime' });
  });

  it('rejects unknown plugins and non-JSON runtime input', () => {
    expect(() => createConfigurationStore({ 'test/unknown': {} }, ['test/known'])).toThrow(
      /unknown plugin/,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      createConfigurationStore({ 'test/known': cyclic as unknown as JsonObject }, ['test/known']),
    ).toThrow(/cyclic/);
    expect(() =>
      createConfigurationStore({ 'test/known': { invalid: Number.NaN } }, ['test/known']),
    ).toThrow(/finite/);
    expect(() =>
      createConfigurationStore({ 'test/known': { invalid: new Date() } as unknown as JsonObject }, [
        'test/known',
      ]),
    ).toThrow(/plain or null prototype/);
  });

  it('returns immutable point-in-time snapshots', () => {
    const store = createConfigurationStore({ 'test/plugin': { count: 1 } }, ['test/plugin']);
    const snapshot = store.snapshot();
    const overlay = store.createOverlay({ 'test/plugin': { count: 2 } });

    expect(snapshot).toEqual({ 'test/plugin': { count: 1 } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(overlay.snapshot()).toEqual({ 'test/plugin': { count: 2 } });
  });
});
