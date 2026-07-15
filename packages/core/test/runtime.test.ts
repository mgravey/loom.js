import {
  CAPABILITY_REGISTRATION_EVENT,
  PLUGIN_API_VERSION,
  RUNTIME_STATE_EVENT,
  createCapabilityKey,
  createEventKey,
  createServiceToken,
  definePlugin,
  type LoomPlugin,
} from '@loom/plugin-api';
import { pluginId, semanticVersion, sessionId, type JsonObject } from '@loom/types';
import { describe, expect, it, vi } from 'vitest';

import { createLoomRuntime } from '../src/runtime.js';

function plugin(
  id: string,
  hooks: Omit<LoomPlugin, 'manifest'> = {},
  dependencies: { required?: readonly string[]; optional?: readonly string[] } = {},
): LoomPlugin {
  return definePlugin({
    manifest: {
      id: pluginId(id),
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
      ...(dependencies.required === undefined
        ? {}
        : { requiredPlugins: dependencies.required.map(pluginId) }),
      ...(dependencies.optional === undefined
        ? {}
        : { optionalPlugins: dependencies.optional.map(pluginId) }),
    },
    ...hooks,
  });
}

describe('Loom runtime lifecycle', () => {
  it('orders required dependencies deterministically and tears down in reverse', async () => {
    const calls: string[] = [];
    const make = (id: string, required?: readonly string[]) =>
      plugin(
        id,
        {
          initialize: () => void calls.push(`initialize:${id}`),
          start: () => void calls.push(`start:${id}`),
          stop: () => void calls.push(`stop:${id}`),
          dispose: () => void calls.push(`dispose:${id}`),
        },
        required === undefined ? {} : { required },
      );
    const runtime = createLoomRuntime({
      plugins: [make('test/consumer', ['test/base']), make('test/independent'), make('test/base')],
    });

    await runtime.initialize();
    await runtime.start();
    await runtime.stop();
    await runtime.dispose();

    expect(calls).toEqual([
      'initialize:test/independent',
      'initialize:test/base',
      'initialize:test/consumer',
      'start:test/independent',
      'start:test/base',
      'start:test/consumer',
      'stop:test/consumer',
      'stop:test/base',
      'stop:test/independent',
      'dispose:test/consumer',
      'dispose:test/base',
      'dispose:test/independent',
    ]);
    expect(runtime.state).toBe('disposed');
    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('validates plugin identity, API compatibility, required dependencies, and cycles', () => {
    const base = plugin('test/base');
    expect(() => createLoomRuntime({ plugins: [base, base] })).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_PLUGIN' }),
    );
    expect(() =>
      createLoomRuntime({ plugins: [plugin('test/consumer', {}, { required: ['test/missing'] })] }),
    ).toThrowError(expect.objectContaining({ code: 'MISSING_PLUGIN_DEPENDENCY' }));
    expect(() =>
      createLoomRuntime({
        plugins: [
          plugin('test/one', {}, { required: ['test/two'] }),
          plugin('test/two', {}, { required: ['test/one'] }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PLUGIN_DEPENDENCY_CYCLE' }));
    expect(() =>
      createLoomRuntime({
        plugins: [
          {
            manifest: {
              ...base.manifest,
              id: pluginId('test/incompatible'),
              apiVersion: PLUGIN_API_VERSION + 1,
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PLUGIN_API_VERSION_MISMATCH' }));

    const invalid = {
      manifest: {
        id: 'not-namespaced',
        version: 'not-semver',
        apiVersion: PLUGIN_API_VERSION,
      },
    } as unknown as LoomPlugin;
    expect(() => createLoomRuntime({ plugins: [invalid] })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ID' }),
    );
    expect(() =>
      createLoomRuntime({
        plugins: [plugin('test/optional', {}, { optional: ['test/not-installed'] })],
      }),
    ).not.toThrow();
  });

  it('rolls back initialized plugins and partial registrations after initialize failure', async () => {
    const calls: string[] = [];
    const capability = createCapabilityKey('tool', 'test/partial');
    const runtime = createLoomRuntime({
      plugins: [
        plugin('test/base', {
          initialize: () => void calls.push('base:initialize'),
          dispose: () => void calls.push('base:dispose'),
        }),
        plugin('test/failing', {
          initialize(context) {
            context.capabilities.register(capability, { partial: true });
            throw new Error('initialize failed');
          },
        }),
      ],
    });

    await expect(runtime.initialize()).rejects.toMatchObject({
      code: 'PLUGIN_INITIALIZATION_FAILED',
    });
    expect(runtime.state).toBe('failed');
    expect(runtime.capabilities.has(capability)).toBe(false);
    expect(calls).toEqual(['base:initialize', 'base:dispose']);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(runtime.state).toBe('failed');
  });

  it('stops started plugins and disposes all initialized plugins after start failure', async () => {
    const calls: string[] = [];
    const runtime = createLoomRuntime({
      plugins: [
        plugin('test/base', {
          start: () => void calls.push('base:start'),
          stop: () => void calls.push('base:stop'),
          dispose: () => void calls.push('base:dispose'),
        }),
        plugin('test/failing', {
          start() {
            calls.push('failing:start');
            throw new Error('start failed');
          },
          dispose: () => void calls.push('failing:dispose'),
        }),
      ],
    });
    await runtime.initialize();

    await expect(runtime.start()).rejects.toMatchObject({ code: 'PLUGIN_START_FAILED' });
    expect(calls).toEqual([
      'base:start',
      'failing:start',
      'base:stop',
      'failing:dispose',
      'base:dispose',
    ]);
    expect(runtime.state).toBe('failed');
  });

  it('freezes registration before start and keeps lifecycle errors typed', async () => {
    const late = createCapabilityKey('tool', 'test/late');
    let registerLate: (() => void) | undefined;
    const runtime = createLoomRuntime({
      plugins: [
        plugin('test/late-writer', {
          initialize(context) {
            registerLate = () => context.capabilities.register(late, {});
          },
          start() {
            registerLate?.();
          },
        }),
      ],
    });
    await expect(runtime.start()).rejects.toMatchObject({
      code: 'INVALID_LIFECYCLE_TRANSITION',
    });
    await runtime.initialize();
    await expect(runtime.start()).rejects.toMatchObject({ code: 'PLUGIN_START_FAILED' });
  });

  it('isolates runtime events and reports listener failures without breaking lifecycle', async () => {
    const errors: unknown[] = [];
    const capabilityEvents: string[] = [];
    const runtime = createLoomRuntime({
      errorSink: (error) => errors.push(error),
      plugins: [
        plugin('test/events', {
          initialize(context) {
            context.events.on(CAPABILITY_REGISTRATION_EVENT, (event) => {
              capabilityEvents.push(`${event.action}:${event.capabilityId}`);
            });
            context.events.on(RUNTIME_STATE_EVENT, () => {
              throw new Error('listener failed');
            });
            context.capabilities.register(createCapabilityKey('tool', 'test/evented'), {});
          },
        }),
      ],
    });

    await runtime.initialize();
    await runtime.start();
    await runtime.stop();
    await runtime.dispose();

    expect(capabilityEvents).toEqual(['registered:test/evented', 'removed:test/evented']);
    expect(errors).toHaveLength(4);
    expect(runtime.state).toBe('disposed');
  });

  it('attempts every stop and dispose hook and aggregates cleanup failures', async () => {
    const calls: string[] = [];
    const failing = (id: string) =>
      plugin(id, {
        stop() {
          calls.push(`stop:${id}`);
          throw new Error(`stop:${id}`);
        },
        dispose() {
          calls.push(`dispose:${id}`);
          throw new Error(`dispose:${id}`);
        },
      });
    const runtime = createLoomRuntime({
      plugins: [failing('test/one'), failing('test/two')],
    });
    await runtime.initialize();
    await runtime.start();

    await expect(runtime.dispose()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(calls).toEqual([
      'stop:test/two',
      'stop:test/one',
      'dispose:test/two',
      'dispose:test/one',
    ]);
    expect(runtime.state).toBe('disposed');
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});

describe('Loom sessions', () => {
  it('provides isolated configuration, events, services, and cancellation scopes', async () => {
    const owner = pluginId('test/session-owner');
    const token = createServiceToken<{ readonly instance: number }>('test/session-service');
    let instances = 0;
    const runtime = createLoomRuntime({
      configuration: { [owner]: { level: 'runtime' } },
      plugins: [
        plugin(owner, {
          initialize(context) {
            context.services.registerFactory(
              token,
              () => Object.freeze({ instance: ++instances }),
              { lifetime: 'session' },
            );
          },
        }),
      ],
    });
    await runtime.initialize();
    await runtime.start();

    const first = await runtime.sessions.create({
      id: sessionId('first'),
      attributes: { label: 'first' },
      configuration: { [owner]: { level: 'session' } },
    });
    const second = await runtime.sessions.create({ id: sessionId('second') });
    const firstValue = await first.services.get(token);
    expect(await first.services.get(token)).toBe(firstValue);
    expect(await second.services.get(token)).not.toBe(firstValue);
    expect((first.configuration[owner] as JsonObject).level).toBe('session');
    expect((second.configuration[owner] as JsonObject).level).toBe('runtime');

    const event = createEventKey<string>('test/session-event');
    const observed = vi.fn();
    first.events.on(event, observed);
    await second.events.emit(event, 'second');
    await first.events.emit(event, 'first');
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith('first');

    await first.close('done');
    expect(first.signal.cancelled).toBe(true);
    expect(first.signal.reason).toBe('done');
    expect(runtime.sessions.tryGet(first.metadata.id)).toBeUndefined();
    expect(() => runtime.sessions.get(first.metadata.id)).toThrowError(
      expect.objectContaining({ code: 'MISSING_SESSION' }),
    );
    await expect(runtime.sessions.close(sessionId('missing'))).resolves.toBeUndefined();
    await expect(first.close()).resolves.toBeUndefined();
    await runtime.stop();
    expect(second.signal.cancelled).toBe(true);
    await runtime.dispose();
  });

  it('rejects duplicate or out-of-lifecycle sessions and keeps runtimes isolated', async () => {
    const first = createLoomRuntime({ plugins: [] });
    const second = createLoomRuntime({ plugins: [] });
    const id = sessionId('shared-name');
    await expect(first.sessions.create({ id })).rejects.toMatchObject({
      code: 'INVALID_LIFECYCLE_TRANSITION',
    });
    await first.initialize();
    await first.start();
    await second.initialize();
    await second.start();
    await first.sessions.create({ id });
    await second.sessions.create({ id });
    await expect(first.sessions.create({ id })).rejects.toMatchObject({
      code: 'DUPLICATE_SESSION',
    });
    expect(first.sessions.list()).toHaveLength(1);
    expect(second.sessions.list()).toHaveLength(1);
    await first.dispose();
    expect(second.state).toBe('running');
    expect(second.sessions.list()).toHaveLength(1);
    await second.dispose();
  });
});
