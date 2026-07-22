import {
  PLUGIN_API_VERSION,
  createServiceToken,
  definePlugin,
  registerAgent,
  registerAuth,
  registerMemory,
  registerModel,
  registerPlatform,
  registerRuntime,
  registerStorage,
  registerTool,
  registerUi,
  type AgentFactory,
  type AgentDependencies,
  type AuthProvider,
  type ExecutionRuntime,
  type Memory,
  type Model,
  type OperationContext,
  type Platform,
  type Storage,
  type Tool,
  type UserInterface,
} from '@mgravey/loom-plugin-api';
import {
  capabilityId,
  pluginId,
  semanticVersion,
  type JsonValue,
  type NamespacedId,
} from '@mgravey/loom-types';

export * from './phase-two.js';

export const EXAMPLE_PLUGIN_ID = pluginId('loom-example/all-capabilities');

export const EXAMPLE_CAPABILITY_IDS = Object.freeze({
  agent: capabilityId('loom-example/agent'),
  model: capabilityId('loom-example/model'),
  auth: capabilityId('loom-example/auth'),
  tool: capabilityId('loom-example/tool'),
  storage: capabilityId('loom-example/storage'),
  runtime: capabilityId('loom-example/runtime'),
  memory: capabilityId('loom-example/memory'),
  platform: capabilityId('loom-example/platform'),
  ui: capabilityId('loom-example/ui'),
});

export interface ExampleStatusService {
  readonly ready: true;
}

export const EXAMPLE_STATUS_SERVICE =
  createServiceToken<ExampleStatusService>('loom-example/status');

const exampleAuth: AuthProvider = Object.freeze({
  getAccessToken: () => Promise.resolve('example-access-token'),
});

const exampleModel: Model = Object.freeze({
  async *generate(request: JsonValue) {
    yield await Promise.resolve(Object.freeze({ type: 'output', data: request }));
  },
});

const exampleTool: Tool = Object.freeze({
  name: 'example-identity',
  description: 'Returns its JSON input unchanged.',
  execute: (input: JsonValue) => Promise.resolve(input),
});

const exampleAgent: AgentFactory = Object.freeze({
  create: (dependencies: AgentDependencies) =>
    Object.freeze({
      async *run(request: JsonValue, context?: OperationContext) {
        for await (const event of dependencies.model.generate(request, context)) {
          yield Object.freeze({ type: `model:${event.type}`, data: event.data });
        }
      },
    }),
});

const exampleExecutionRuntime: ExecutionRuntime = Object.freeze({
  async *execute(request: JsonValue) {
    yield await Promise.resolve(Object.freeze({ type: 'result', data: request }));
  },
});

const exampleMemory: Memory = Object.freeze({ kind: 'example-memory' });
const examplePlatform: Platform = Object.freeze({ kind: 'example-platform' });
const exampleUi: UserInterface = Object.freeze({ kind: 'example-ui' });

function createExampleStorage(): Storage {
  const namespaces = new Map<NamespacedId, Map<string, Uint8Array>>();

  function namespaceFor(namespace: NamespacedId): Map<string, Uint8Array> {
    let values = namespaces.get(namespace);
    if (values === undefined) {
      values = new Map();
      namespaces.set(namespace, values);
    }
    return values;
  }

  return Object.freeze({
    get: (namespace: NamespacedId, key: string) => {
      const value = namespaces.get(namespace)?.get(key);
      return Promise.resolve(value === undefined ? undefined : value.slice());
    },
    set: (namespace: NamespacedId, key: string, value: Uint8Array) => {
      namespaceFor(namespace).set(key, value.slice());
      return Promise.resolve();
    },
    delete: (namespace: NamespacedId, key: string) => {
      const values = namespaces.get(namespace);
      if (values === undefined) return Promise.resolve(false);
      const deleted = values.delete(key);
      if (values.size === 0) namespaces.delete(namespace);
      return Promise.resolve(deleted);
    },
    list: (namespace: NamespacedId) =>
      Promise.resolve(Object.freeze([...(namespaces.get(namespace)?.keys() ?? [])].sort())),
  });
}

/**
 * A deliberately provider-neutral fixture plugin used by examples and compatibility tests.
 * It demonstrates every built-in capability category through public APIs only.
 */
export function createAllCapabilitiesPlugin() {
  return definePlugin({
    manifest: {
      id: EXAMPLE_PLUGIN_ID,
      version: semanticVersion('0.1.0'),
      apiVersion: PLUGIN_API_VERSION,
      requiredPlugins: [],
      optionalPlugins: [],
    },
    initialize(context) {
      registerAgent(context.capabilities, EXAMPLE_CAPABILITY_IDS.agent, exampleAgent);
      registerModel(context.capabilities, EXAMPLE_CAPABILITY_IDS.model, exampleModel);
      registerAuth(context.capabilities, EXAMPLE_CAPABILITY_IDS.auth, exampleAuth);
      registerTool(context.capabilities, EXAMPLE_CAPABILITY_IDS.tool, exampleTool);
      registerStorage(context.capabilities, EXAMPLE_CAPABILITY_IDS.storage, createExampleStorage());
      registerRuntime(
        context.capabilities,
        EXAMPLE_CAPABILITY_IDS.runtime,
        exampleExecutionRuntime,
      );
      registerMemory(context.capabilities, EXAMPLE_CAPABILITY_IDS.memory, exampleMemory);
      registerPlatform(context.capabilities, EXAMPLE_CAPABILITY_IDS.platform, examplePlatform);
      registerUi(context.capabilities, EXAMPLE_CAPABILITY_IDS.ui, exampleUi);
      context.services.registerValue(
        EXAMPLE_STATUS_SERVICE,
        Object.freeze({ ready: true as const }),
      );
    },
  });
}

/** A small JSON request useful when manually trying the example model, tool, or runtime. */
export const EXAMPLE_REQUEST: JsonValue = Object.freeze({ message: 'hello from Loom' });
