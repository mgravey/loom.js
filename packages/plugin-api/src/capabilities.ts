import type {
  CancellationSignal,
  CapabilityId,
  DeepReadonly,
  JsonObject,
  JsonValue,
  NamespacedId,
  PluginId,
  SessionId,
} from '@mgravey/loom-types';
import { capabilityId } from '@mgravey/loom-types';

export const CAPABILITY_KINDS = Object.freeze({
  agent: 'agent',
  model: 'model',
  auth: 'auth',
  tool: 'tool',
  storage: 'storage',
  runtime: 'runtime',
  memory: 'memory',
  platform: 'platform',
  ui: 'ui',
} as const);

export type BuiltinCapabilityKind = (typeof CAPABILITY_KINDS)[keyof typeof CAPABILITY_KINDS];
export type CapabilityKind = BuiltinCapabilityKind | (string & {});

/** A structural key: identity is its `kind` and `id`, never object identity. */
export interface CapabilityKey<Capability> {
  readonly kind: CapabilityKind;
  readonly id: CapabilityId;
  /** Compile-time-only invariant marker. */
  readonly __capability?: (value: Capability) => Capability;
}

export interface CapabilityEntry<Capability = unknown> {
  readonly key: CapabilityKey<Capability>;
  readonly value: Capability;
  readonly owner: PluginId;
}

export function createCapabilityKey<Capability>(
  kind: CapabilityKind,
  id: string | CapabilityId,
): CapabilityKey<Capability> {
  if (kind.trim().length === 0) {
    throw new TypeError('Capability kind must be non-empty.');
  }
  return Object.freeze({ kind, id: capabilityId(id) });
}

export interface CapabilityRegistryReader {
  get<Capability>(key: CapabilityKey<Capability>): Capability;
  tryGet<Capability>(key: CapabilityKey<Capability>): Capability | undefined;
  has<Capability>(key: CapabilityKey<Capability>): boolean;
  /** Returns an immutable point-in-time snapshot. */
  list(kind?: CapabilityKind): readonly CapabilityEntry[];
}

/** Available only to a plugin while its initialize hook is executing. */
export interface CapabilityRegistrar {
  register<Capability>(key: CapabilityKey<Capability>, capability: Capability): void;
}

export interface AuthProvider {
  getAccessToken(): Promise<string>;
}

export interface OperationContext {
  readonly signal?: CancellationSignal;
  readonly sessionId?: SessionId;
}

export interface ModelEvent<Data = JsonValue> {
  readonly type: string;
  readonly data: Data;
}

export interface Model<Request = JsonValue, Event = ModelEvent> {
  generate(request: Request, context?: OperationContext): AsyncIterable<Event>;
}

export interface Tool<Input = JsonValue, Output = JsonValue> {
  readonly name: string;
  readonly description?: string;
  execute(input: Input, context?: OperationContext): Promise<Output>;
}

export type Memory = object;
export type Platform = object;
export type UserInterface = object;

export interface AgentDependencies<
  ModelType = Model,
  ToolType = Tool,
  MemoryType extends Memory = Memory,
> {
  readonly model: ModelType;
  readonly tools: readonly ToolType[];
  readonly memory?: MemoryType;
  readonly configuration: DeepReadonly<JsonObject>;
}

export interface AgentEvent<Data = JsonValue> {
  readonly type: string;
  readonly data: Data;
}

export interface Agent<Request = JsonValue, Event = AgentEvent> {
  run(request: Request, context?: OperationContext): AsyncIterable<Event>;
}

export interface AgentFactory<
  Request = JsonValue,
  Event = AgentEvent,
  Dependencies extends AgentDependencies<unknown, unknown> = AgentDependencies,
> {
  create(dependencies: Dependencies): Agent<Request, Event> | Promise<Agent<Request, Event>>;
}

export interface ExecutionEvent<Data = JsonValue> {
  readonly type: string;
  readonly data: Data;
}

export interface ExecutionRuntime<Request = JsonValue, Event = ExecutionEvent> {
  execute(request: Request, context?: OperationContext): AsyncIterable<Event>;
}

export interface Storage {
  get(namespace: NamespacedId, key: string): Promise<Uint8Array | undefined>;
  set(namespace: NamespacedId, key: string, value: Uint8Array): Promise<void>;
  delete(namespace: NamespacedId, key: string): Promise<boolean>;
  list(namespace: NamespacedId): Promise<readonly string[]>;
}

export const agentKey = <
  Request = JsonValue,
  Event = AgentEvent,
  Dependencies extends AgentDependencies<unknown, unknown> = AgentDependencies,
>(
  id: string | CapabilityId,
) => createCapabilityKey<AgentFactory<Request, Event, Dependencies>>(CAPABILITY_KINDS.agent, id);
export const modelKey = <Request = JsonValue, Event = ModelEvent>(id: string | CapabilityId) =>
  createCapabilityKey<Model<Request, Event>>(CAPABILITY_KINDS.model, id);
export const authKey = (id: string | CapabilityId) =>
  createCapabilityKey<AuthProvider>(CAPABILITY_KINDS.auth, id);
export const toolKey = <Input = JsonValue, Output = JsonValue>(id: string | CapabilityId) =>
  createCapabilityKey<Tool<Input, Output>>(CAPABILITY_KINDS.tool, id);
export const storageKey = (id: string | CapabilityId) =>
  createCapabilityKey<Storage>(CAPABILITY_KINDS.storage, id);
export const runtimeKey = <Request = JsonValue, Event = ExecutionEvent>(
  id: string | CapabilityId,
) => createCapabilityKey<ExecutionRuntime<Request, Event>>(CAPABILITY_KINDS.runtime, id);
export const memoryKey = (id: string | CapabilityId) =>
  createCapabilityKey<Memory>(CAPABILITY_KINDS.memory, id);
export const platformKey = (id: string | CapabilityId) =>
  createCapabilityKey<Platform>(CAPABILITY_KINDS.platform, id);
export const uiKey = (id: string | CapabilityId) =>
  createCapabilityKey<UserInterface>(CAPABILITY_KINDS.ui, id);

export function registerAgent<
  Request = JsonValue,
  Event = AgentEvent,
  Dependencies extends AgentDependencies<unknown, unknown> = AgentDependencies,
>(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: AgentFactory<Request, Event, Dependencies>,
): void {
  registrar.register(agentKey<Request, Event, Dependencies>(id), capability);
}
export function registerModel<Request = JsonValue, Event = ModelEvent>(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: Model<Request, Event>,
): void {
  registrar.register(modelKey<Request, Event>(id), capability);
}
export function registerAuth(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: AuthProvider,
): void {
  registrar.register(authKey(id), capability);
}
export function registerTool<Input = JsonValue, Output = JsonValue>(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: Tool<Input, Output>,
): void {
  registrar.register(toolKey<Input, Output>(id), capability);
}
export function registerStorage(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: Storage,
): void {
  registrar.register(storageKey(id), capability);
}
export function registerRuntime<Request = JsonValue, Event = ExecutionEvent>(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: ExecutionRuntime<Request, Event>,
): void {
  registrar.register(runtimeKey<Request, Event>(id), capability);
}
export function registerMemory(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: Memory,
): void {
  registrar.register(memoryKey(id), capability);
}
export function registerPlatform(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: Platform,
): void {
  registrar.register(platformKey(id), capability);
}
export function registerUi(
  registrar: CapabilityRegistrar,
  id: string | CapabilityId,
  capability: UserInterface,
): void {
  registrar.register(uiKey(id), capability);
}
