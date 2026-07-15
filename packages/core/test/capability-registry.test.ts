import { createCapabilityKey } from '@loom/plugin-api';
import { describe, expect, it } from 'vitest';

import { createCapabilityRegistry } from '../src/capability-registry.js';

describe('capability registry', () => {
  it('uses structural kind/id identity and returns immutable snapshots', () => {
    const registry = createCapabilityRegistry();
    const key = createCapabilityKey<{ readonly name: string }>('tool', 'test/reader');
    const equivalent = createCapabilityKey<{ readonly name: string }>('tool', 'test/reader');
    const value = { name: 'reader' };

    registry.registrarFor('test/plugin').register(key, value);

    expect(registry.reader.get(equivalent)).toBe(value);
    expect(registry.reader.tryGet(equivalent)).toBe(value);
    expect(registry.reader.has(equivalent)).toBe(true);
    expect(registry.reader.list()).toHaveLength(1);
    const snapshot = registry.reader.list('tool');
    expect(snapshot).toEqual([{ key, value, owner: 'test/plugin' }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it('rejects duplicates even when different key objects are used', () => {
    const registry = createCapabilityRegistry();
    registry.registrarFor('test/one').register(createCapabilityKey('tool', 'test/shared'), {});

    expect(() =>
      registry.registrarFor('test/two').register(createCapabilityKey('tool', 'test/shared'), {}),
    ).toThrow(/already registered/);
  });

  it('removes all registrations owned by a plugin', () => {
    const registry = createCapabilityRegistry();
    const one = createCapabilityKey('tool', 'test/one');
    const two = createCapabilityKey('model', 'test/two');
    const other = createCapabilityKey('tool', 'test/other');
    const registrar = registry.registrarFor('test/plugin');
    registrar.register(one, {});
    registrar.register(two, {});
    registry.registrarFor('test/other').register(other, {});

    registry.removeOwner('test/plugin');
    registry.removeOwner('test/plugin');

    expect(registry.reader.has(one)).toBe(false);
    expect(registry.reader.has(two)).toBe(false);
    expect(registry.reader.has(other)).toBe(true);
    expect(registry.reader.tryGet(one)).toBeUndefined();
    expect(() => registry.reader.get(one)).toThrow(/not registered/);
  });

  it('closes only the registration side when frozen', () => {
    const registry = createCapabilityRegistry();
    const key = createCapabilityKey('tool', 'test/value');
    registry.registrarFor('test/plugin').register(key, 42);
    registry.freeze();

    expect(registry.frozen).toBe(true);
    expect(registry.reader.get(key)).toBe(42);
    expect(() =>
      registry.registrarFor('test/plugin').register(createCapabilityKey('tool', 'test/late'), 1),
    ).toThrow(/closed/);
    registry.removeOwner('test/plugin');
    expect(registry.reader.has(key)).toBe(false);
  });
});
