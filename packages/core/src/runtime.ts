import {
  CAPABILITY_REGISTRATION_EVENT,
  PLUGIN_STATE_EVENT,
  RUNTIME_STATE_EVENT,
  type CapabilityKey,
  type CapabilityRegistrar,
  type CapabilityRegistryReader,
  type CreateLoomRuntimeOptions,
  type LoomPlugin,
  type LoomRuntime,
  type PluginInitializeContext,
  type PluginRuntimeContext,
  type ServiceFactory,
  type ServiceLifetime,
  type ServiceRegistrar,
  type ServiceResolver,
  type ServiceToken,
} from '@mgravey/loom-plugin-api';
import {
  LoomAggregateError,
  LoomError,
  systemClock,
  type PluginId,
  type PluginState,
  type RuntimeState,
} from '@mgravey/loom-types';

import { createCapabilityRegistry } from './capability-registry.js';
import { createConfigurationStore } from './configuration.js';
import { createEventBus } from './event-bus.js';
import { validatePluginGraph } from './plugin-graph.js';
import { createServiceContainer } from './service-container.js';
import { createSessionManager } from './session-manager.js';

function lifecycleError(operation: string, state: RuntimeState): LoomError {
  return new LoomError(
    'INVALID_LIFECYCLE_TRANSITION',
    `Cannot ${operation} a Loom runtime in '${state}' state.`,
    { details: { operation, state } },
  );
}

function combineFailures(
  code: 'PLUGIN_INITIALIZATION_FAILED' | 'PLUGIN_START_FAILED' | 'CLEANUP_FAILED',
  message: string,
  errors: readonly unknown[],
): LoomError {
  if (errors.length === 1) {
    return new LoomError(code, message, { cause: errors[0] });
  }
  return new LoomAggregateError(code, message, errors);
}

/** Creates a fully isolated Loom runtime from a fixed plugin set. */
export function createLoomRuntime(options: CreateLoomRuntimeOptions): LoomRuntime {
  const plugins = Object.freeze([...options.plugins]);
  const graph = validatePluginGraph(plugins);
  const clock = options.clock ?? systemClock;
  const errorSink = options.errorSink ?? (() => undefined);
  const events = createEventBus((error) => errorSink(error));
  const capabilities = createCapabilityRegistry((change) => {
    void events.emit(
      CAPABILITY_REGISTRATION_EVENT,
      Object.freeze({
        owner: change.owner,
        kind: change.key.kind,
        capabilityId: change.key.id,
        action: change.action,
        timestamp: clock.now(),
      }),
    );
  });
  const services = createServiceContainer();
  const configuration = createConfigurationStore(options.configuration, graph.byId.keys());
  const pluginStates = new Map<PluginId, PluginState>();
  for (const plugin of graph.ordered) pluginStates.set(plugin.manifest.id, 'registered');

  let state: RuntimeState = 'created';
  let initialized: LoomPlugin[] = [];
  let started: LoomPlugin[] = [];
  let rollbackComplete = false;
  let disposalComplete = false;

  async function setRuntimeState(next: RuntimeState): Promise<void> {
    if (state === next) return;
    const previous = state;
    state = next;
    await events.emit(
      RUNTIME_STATE_EVENT,
      Object.freeze({ previous, current: next, timestamp: clock.now() }),
    );
  }

  async function setPluginState(plugin: LoomPlugin, next: PluginState): Promise<void> {
    const previous = pluginStates.get(plugin.manifest.id) ?? 'registered';
    if (previous === next) return;
    pluginStates.set(plugin.manifest.id, next);
    await events.emit(
      PLUGIN_STATE_EVENT,
      Object.freeze({
        pluginId: plugin.manifest.id,
        previous,
        current: next,
        timestamp: clock.now(),
      }),
    );
  }

  function capabilityAccess(
    pluginId: PluginId,
    isRegistrationOpen: () => boolean,
  ): CapabilityRegistryReader & CapabilityRegistrar {
    const registrar = capabilities.registrarFor(pluginId);
    return Object.freeze({
      get: <T>(key: CapabilityKey<T>) => capabilities.reader.get(key),
      tryGet: <T>(key: CapabilityKey<T>) => capabilities.reader.tryGet(key),
      has: <T>(key: CapabilityKey<T>) => capabilities.reader.has(key),
      list: (kind?: Parameters<CapabilityRegistryReader['list']>[0]) =>
        capabilities.reader.list(kind),
      register: <T>(key: CapabilityKey<T>, value: T) => {
        if (!isRegistrationOpen()) {
          throw new LoomError(
            'REGISTRATION_CLOSED',
            `Plugin '${pluginId}' may only register capabilities during its initialize hook.`,
          );
        }
        registrar.register(key, value);
      },
    });
  }

  function serviceAccess(
    pluginId: PluginId,
    isRegistrationOpen: () => boolean,
  ): ServiceResolver & ServiceRegistrar {
    const registrar = services.registrarFor(pluginId);
    return Object.freeze({
      get: <T>(token: ServiceToken<T>) => services.root.get(token),
      tryGet: <T>(token: ServiceToken<T>) => services.root.tryGet(token),
      registerValue: <T>(token: ServiceToken<T>, value: T) => {
        if (!isRegistrationOpen()) {
          throw new LoomError(
            'REGISTRATION_CLOSED',
            `Plugin '${pluginId}' may only register services during its initialize hook.`,
          );
        }
        registrar.registerValue(token, value);
      },
      registerFactory: <T>(
        token: ServiceToken<T>,
        factory: ServiceFactory<T>,
        factoryOptions?: { readonly lifetime?: ServiceLifetime },
      ) => {
        if (!isRegistrationOpen()) {
          throw new LoomError(
            'REGISTRATION_CLOSED',
            `Plugin '${pluginId}' may only register services during its initialize hook.`,
          );
        }
        return factoryOptions === undefined
          ? registrar.registerFactory(token, factory)
          : registrar.registerFactory(token, factory, factoryOptions);
      },
    });
  }

  function initializeContext(
    plugin: LoomPlugin,
    isRegistrationOpen: () => boolean,
  ): PluginInitializeContext {
    return Object.freeze({
      pluginId: plugin.manifest.id,
      configuration: configuration.forPlugin(plugin.manifest.id).get(),
      clock,
      events,
      capabilities: capabilityAccess(plugin.manifest.id, isRegistrationOpen),
      services: serviceAccess(plugin.manifest.id, isRegistrationOpen),
    });
  }

  function runtimeContext(plugin: LoomPlugin): PluginRuntimeContext {
    return Object.freeze({
      pluginId: plugin.manifest.id,
      configuration: configuration.forPlugin(plugin.manifest.id).get(),
      clock,
      events,
      capabilities: capabilities.reader,
      services: services.root,
    });
  }

  async function removeOwned(plugin: LoomPlugin, errors: unknown[]): Promise<void> {
    capabilities.removeOwner(plugin.manifest.id);
    try {
      await services.removeOwner(plugin.manifest.id);
    } catch (error) {
      errors.push(error);
    }
  }

  async function disposePlugins(targets: readonly LoomPlugin[], errors: unknown[]): Promise<void> {
    for (const plugin of [...targets].reverse()) {
      await setPluginState(plugin, 'disposing');
      try {
        await plugin.dispose?.(runtimeContext(plugin));
        await setPluginState(plugin, 'disposed');
      } catch (error) {
        errors.push(error);
        await setPluginState(plugin, 'failed');
      }
      await removeOwned(plugin, errors);
    }
  }

  async function rollbackInitialization(failing: LoomPlugin, cause: unknown): Promise<never> {
    const errors: unknown[] = [cause];
    await setPluginState(failing, 'failed');
    await removeOwned(failing, errors);
    await disposePlugins(initialized, errors);
    initialized = [];
    rollbackComplete = true;
    await setRuntimeState('failed');
    throw combineFailures(
      'PLUGIN_INITIALIZATION_FAILED',
      `Plugin '${failing.manifest.id}' failed to initialize.`,
      errors,
    );
  }

  async function rollbackStart(failing: LoomPlugin, cause: unknown): Promise<never> {
    const errors: unknown[] = [cause];
    await setPluginState(failing, 'failed');
    for (const plugin of [...started].reverse()) {
      await setPluginState(plugin, 'stopping');
      try {
        await plugin.stop?.(runtimeContext(plugin));
        await setPluginState(plugin, 'stopped');
      } catch (error) {
        errors.push(error);
        await setPluginState(plugin, 'failed');
      }
    }
    started = [];
    await disposePlugins(initialized, errors);
    initialized = [];
    rollbackComplete = true;
    await setRuntimeState('failed');
    throw combineFailures(
      'PLUGIN_START_FAILED',
      `Plugin '${failing.manifest.id}' failed to start.`,
      errors,
    );
  }

  const sessionController = createSessionManager({
    clock,
    errorSink,
    configuration,
    capabilities: capabilities.reader,
    services,
    runtimeEvents: events,
    isRunning: () => state === 'running',
  });

  const runtime: LoomRuntime = Object.freeze({
    get state(): RuntimeState {
      return state;
    },
    capabilities: capabilities.reader,
    services: services.root,
    events,
    sessions: sessionController.public,

    async initialize(): Promise<void> {
      if (state !== 'created') throw lifecycleError('initialize', state);
      for (const plugin of graph.ordered) {
        await setPluginState(plugin, 'initializing');
        let registrationOpen = true;
        try {
          await plugin.initialize?.(initializeContext(plugin, () => registrationOpen));
          initialized.push(plugin);
          await setPluginState(plugin, 'initialized');
        } catch (error) {
          await rollbackInitialization(plugin, error);
        } finally {
          registrationOpen = false;
        }
      }
      capabilities.freeze();
      services.freeze();
      await setRuntimeState('initialized');
    },

    async start(): Promise<void> {
      if (state !== 'initialized') throw lifecycleError('start', state);
      for (const plugin of graph.ordered) {
        await setPluginState(plugin, 'starting');
        try {
          await plugin.start?.(runtimeContext(plugin));
          started.push(plugin);
          await setPluginState(plugin, 'running');
        } catch (error) {
          await rollbackStart(plugin, error);
        }
      }
      await setRuntimeState('running');
    },

    async stop(): Promise<void> {
      if (state === 'stopped' || state === 'disposed' || state === 'failed') return;
      if (state !== 'running') throw lifecycleError('stop', state);
      const errors: unknown[] = [];
      try {
        await sessionController.closeAll('Runtime stopped');
      } catch (error) {
        errors.push(error);
      }
      for (const plugin of [...started].reverse()) {
        await setPluginState(plugin, 'stopping');
        try {
          await plugin.stop?.(runtimeContext(plugin));
          await setPluginState(plugin, 'stopped');
        } catch (error) {
          errors.push(error);
          await setPluginState(plugin, 'failed');
        }
      }
      started = [];
      await setRuntimeState('stopped');
      if (errors.length > 0) {
        throw combineFailures(
          'CLEANUP_FAILED',
          `Runtime stopped with ${String(errors.length)} cleanup failure(s).`,
          errors,
        );
      }
    },

    async dispose(): Promise<void> {
      if (disposalComplete) return;
      const errors: unknown[] = [];
      if (state === 'running') {
        try {
          await runtime.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (!rollbackComplete) {
        await disposePlugins(initialized, errors);
        initialized = [];
      }
      try {
        await services.dispose();
      } catch (error) {
        errors.push(error);
      }
      disposalComplete = true;
      if (state !== 'failed') await setRuntimeState('disposed');
      events.clear();
      if (errors.length > 0) {
        throw combineFailures(
          'CLEANUP_FAILED',
          `Runtime disposal completed with ${String(errors.length)} failure(s).`,
          errors,
        );
      }
    },
  });

  return runtime;
}
