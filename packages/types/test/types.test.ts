import { describe, expect, it, vi } from 'vitest';

import {
  CancellationError,
  LoomAggregateError,
  LoomError,
  capabilityId,
  createCancellationSource,
  eventId,
  immutableJson,
  isDisposable,
  isJsonValue,
  isNamespacedId,
  isSemanticVersion,
  namespacedId,
  pluginId,
  semanticVersion,
  serviceId,
  sessionId,
  systemClock,
} from '../src/index.js';

describe('identifier contracts', () => {
  it('accepts namespaced identifiers and semantic versions', () => {
    expect(namespacedId('loom/example.tool')).toBe('loom/example.tool');
    expect(capabilityId('example/tool-1')).toBe('example/tool-1');
    expect(pluginId('example/plugin')).toBe('example/plugin');
    expect(serviceId('example/service')).toBe('example/service');
    expect(eventId('example/event')).toBe('example/event');
    expect(sessionId('caller-chosen-id')).toBe('caller-chosen-id');
    expect(isNamespacedId('example/thing')).toBe(true);
    expect(semanticVersion('1.2.3-beta.1+build.7')).toBe('1.2.3-beta.1+build.7');
    expect(isSemanticVersion('01.0.0')).toBe(false);
  });

  it('rejects unnamespaced and uppercase identifiers', () => {
    expect(() => namespacedId('tool')).toThrow(TypeError);
    expect(() => namespacedId('Loom/tool')).toThrow(TypeError);
    expect(() => semanticVersion('latest')).toThrow(TypeError);
    expect(() => sessionId('   ')).toThrow(TypeError);
  });
});

describe('JSON contracts', () => {
  it('clones and deeply freezes JSON', () => {
    const source = { nested: { value: 1 }, list: [true] };
    const immutable = immutableJson(source);
    source.nested.value = 2;

    expect(immutable).toEqual({ nested: { value: 1 }, list: [true] });
    expect(Object.isFrozen(immutable)).toBe(true);
    expect(Object.isFrozen((immutable as { nested: object }).nested)).toBe(true);
  });

  it('rejects non-finite numbers and non-plain objects', () => {
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(Symbol('not-json'))).toBe(false);
    expect(() => immutableJson(undefined)).toThrow(TypeError);
  });

  it('accepts every JSON primitive and null-prototype objects', () => {
    const dictionary = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: 'ok',
    });
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(1)).toBe(true);
    expect(isJsonValue(['value', false])).toBe(true);
    expect(isJsonValue(dictionary)).toBe(true);
  });
});

describe('cancellation', () => {
  it('notifies once, supports idempotent unsubscribe, and throws', () => {
    const source = createCancellationSource();
    const listener = vi.fn();
    const unsubscribe = source.signal.onCancel(listener);
    source.cancel('done');
    source.cancel('again');
    unsubscribe();
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('done');
    expect(() => source.signal.throwIfCancelled()).toThrow(CancellationError);
  });

  it('immediately notifies late subscribers', () => {
    const source = createCancellationSource();
    source.cancel('early');
    const listener = vi.fn();
    source.signal.onCancel(listener);
    expect(listener).toHaveBeenCalledWith('early');
  });

  it('does not notify listeners unsubscribed before cancellation', () => {
    const source = createCancellationSource();
    const listener = vi.fn();
    source.signal.onCancel(listener)();
    source.cancel();
    expect(listener).not.toHaveBeenCalled();
    expect(source.signal.cancelled).toBe(true);
  });
});

describe('shared runtime utilities', () => {
  it('recognizes Loom-owned disposable values', () => {
    expect(isDisposable({ dispose: vi.fn() })).toBe(true);
    expect(isDisposable({ dispose: true })).toBe(false);
    expect(isDisposable(null)).toBe(false);
  });

  it('exposes a wall clock and structured errors', () => {
    expect(systemClock.now()).toBeGreaterThan(0);
    const cause = new Error('cause');
    const error = new LoomError('INVALID_ID', 'bad id', {
      cause,
      details: { value: 'bad' },
    });
    expect(error).toMatchObject({
      name: 'LoomError',
      code: 'INVALID_ID',
      cause,
      details: { value: 'bad' },
    });

    const aggregate = new LoomAggregateError('CLEANUP_FAILED', 'cleanup', [cause]);
    expect(aggregate.name).toBe('LoomAggregateError');
    expect(aggregate.errors).toEqual([cause]);
    expect(Object.isFrozen(aggregate.errors)).toBe(true);
  });
});
