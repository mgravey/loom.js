import { describe, expect, it, vi } from 'vitest';

import {
  agentKey,
  authKey,
  createCapabilityKey,
  createEventKey,
  createServiceToken,
  definePlugin,
  memoryKey,
  modelKey,
  PLUGIN_API_VERSION,
  platformKey,
  registerAgent,
  registerAuth,
  registerMemory,
  registerModel,
  registerPlatform,
  registerRuntime,
  registerStorage,
  registerTool,
  registerUi,
  runtimeKey,
  storageKey,
  toolKey,
  uiKey,
  type AgentDependencies,
  type AgentFactory,
  type Model,
  type Tool,
} from '../src/index.js';
import { pluginId, semanticVersion } from '@loom/types';

describe('structural keys', () => {
  it('creates independently equivalent capability, service, and event keys', () => {
    expect(toolKey('example/read')).toEqual(createCapabilityKey('tool', 'example/read'));
    expect(createServiceToken('example/cache')).toEqual(createServiceToken('example/cache'));
    expect(createEventKey('example/changed')).toEqual(createEventKey('example/changed'));
  });

  it('provides explicit keys for built-in capability categories', () => {
    expect(agentKey('example/agent').kind).toBe('agent');
    expect(modelKey('example/model').kind).toBe('model');
    expect(authKey('example/auth').kind).toBe('auth');
    expect(storageKey('example/storage').kind).toBe('storage');
    expect(runtimeKey('example/runtime').kind).toBe('runtime');
    expect(memoryKey('example/memory').kind).toBe('memory');
    expect(platformKey('example/platform').kind).toBe('platform');
    expect(uiKey('example/ui').kind).toBe('ui');
    expect(() => createCapabilityKey('', 'example/invalid')).toThrow(TypeError);
  });

  it('registers through the generic registrar', () => {
    const registrar = { register: vi.fn() };
    const tool = {
      name: 'read',
      execute: async () => null,
    };
    registerTool(registrar, 'example/read', tool);
    expect(registrar.register).toHaveBeenCalledWith(toolKey('example/read'), tool);
  });

  it('registers every built-in category through the generic registrar', () => {
    const registrar = { register: vi.fn() };
    const model = {
      async *generate() {
        yield { type: 'done', data: null };
      },
    };
    const agent = {
      create: () => ({
        async *run() {
          yield { type: 'done', data: null };
        },
      }),
    };
    const auth = { getAccessToken: async () => 'token' };
    const storage = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => false,
      list: async () => [],
    };
    const runtime = {
      async *execute() {
        yield { type: 'done', data: null };
      },
    };
    const memory = {};
    const platform = {};
    const ui = {};

    registerAgent(registrar, 'example/agent', agent);
    registerModel(registrar, 'example/model', model);
    registerAuth(registrar, 'example/auth', auth);
    registerStorage(registrar, 'example/storage', storage);
    registerRuntime(registrar, 'example/runtime', runtime);
    registerMemory(registrar, 'example/memory', memory);
    registerPlatform(registrar, 'example/platform', platform);
    registerUi(registrar, 'example/ui', ui);

    expect(registrar.register).toHaveBeenCalledTimes(8);
  });
});

describe('plugin contract', () => {
  it('preserves plugin definitions', () => {
    const plugin = definePlugin({
      manifest: {
        id: pluginId('example/plugin'),
        version: semanticVersion('1.0.0'),
        apiVersion: PLUGIN_API_VERSION,
        requiredPlugins: [],
        optionalPlugins: [],
      },
    });
    expect(plugin.manifest.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it('rejects invalid structural token and event identifiers', () => {
    expect(() => createServiceToken('service')).toThrow(TypeError);
    expect(() => createEventKey('event')).toThrow(TypeError);
  });
});

describe('specialized protocol inference', () => {
  interface Request {
    readonly prompt: string;
  }
  interface Event {
    readonly delta: string;
  }
  interface ToolInput {
    readonly path: string;
  }
  interface ToolOutput {
    readonly content: string;
  }

  it('preserves specialized model, tool, and agent factory types', () => {
    const model: Model<Request, Event> = {
      async *generate(request) {
        yield { delta: request.prompt };
      },
    };
    const tool: Tool<ToolInput, ToolOutput> = {
      name: 'read',
      execute: async ({ path }) => ({ content: path }),
    };
    type Dependencies = AgentDependencies<typeof model, typeof tool>;
    const factory: AgentFactory<Request, Event, Dependencies> = {
      create: (dependencies) => ({
        async *run(request) {
          await dependencies.tools[0]?.execute({ path: request.prompt });
          yield { delta: request.prompt };
        },
      }),
    };
    const registrar = { register: vi.fn() };

    registerModel(registrar, 'example/special-model', model);
    registerTool(registrar, 'example/special-tool', tool);
    registerAgent(registrar, 'example/special-agent', factory);

    expect(modelKey<Request, Event>('example/special-model').kind).toBe('model');
    expect(toolKey<ToolInput, ToolOutput>('example/special-tool').kind).toBe('tool');
    expect(agentKey<Request, Event, Dependencies>('example/special-agent').kind).toBe('agent');
    expect(registrar.register).toHaveBeenCalledTimes(3);
  });
});
