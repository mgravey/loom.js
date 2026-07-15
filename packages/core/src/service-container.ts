import type {
  ServiceFactory,
  ServiceLifetime,
  ServiceRegistrar,
  ServiceResolver,
  ServiceScope,
  ServiceToken,
} from '@loom/plugin-api';
import { pluginId, type Awaitable, type PluginId } from '@loom/types';

import { AggregateDisposalError, CoreError } from './errors.js';
import { assertNonEmpty } from './internal.js';

export interface ManagedServiceScope extends ServiceScope {
  readonly kind: 'runtime' | 'session';
  readonly disposed: boolean;
}

export interface ServiceContainerController {
  readonly root: ManagedServiceScope;
  registrarFor(ownerId: string | PluginId): ServiceRegistrar;
  createSessionScope(): ManagedServiceScope;
  removeOwner(ownerId: string | PluginId): Promise<void>;
  freeze(): void;
  readonly frozen: boolean;
  dispose(): Promise<void>;
}

interface ValueRegistration {
  readonly type: 'value';
  readonly ownerId: string;
  readonly token: ServiceToken<unknown>;
  readonly value: unknown;
}

interface FactoryRegistration {
  readonly type: 'factory';
  readonly ownerId: string;
  readonly token: ServiceToken<unknown>;
  readonly factory: ServiceFactory<unknown>;
  readonly lifetime: ServiceLifetime;
}

type Registration = ValueRegistration | FactoryRegistration;

interface CreatedService {
  readonly tokenId: string;
  readonly value: unknown;
}

interface MutableScope {
  public: ManagedServiceScope;
  readonly kind: 'runtime' | 'session';
  readonly cache: Map<string, Promise<unknown>>;
  readonly pending: Map<string, Set<Promise<unknown>>>;
  readonly created: CreatedService[];
  disposed: boolean;
}

function tokenId<T>(token: ServiceToken<T>): string {
  assertNonEmpty(token.id, 'Service token id');
  return token.id;
}

function isDisposable(value: unknown): value is { dispose(): Awaitable<void> } {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'dispose' in value &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}

async function disposeCreated(entries: CreatedService[]): Promise<void> {
  const errors: unknown[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || !isDisposable(entry.value)) continue;
    try {
      await entry.value.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateDisposalError(errors);
}

/** Creates a runtime-local DI container with owner-aware registrations. */
export function createServiceContainer(): ServiceContainerController {
  const registrations = new Map<string, Registration>();
  const owned = new Map<string, Set<string>>();
  const scopes: MutableScope[] = [];
  let frozen = false;
  let containerDisposed = false;

  function trackPending(scope: MutableScope, id: string, pending: Promise<unknown>): void {
    let tokenPending = scope.pending.get(id);
    if (tokenPending === undefined) {
      tokenPending = new Set();
      scope.pending.set(id, tokenPending);
    }
    tokenPending.add(pending);
    void pending.then(
      () => removePending(scope, id, pending),
      () => removePending(scope, id, pending),
    );
  }

  function removePending(scope: MutableScope, id: string, pending: Promise<unknown>): void {
    const tokenPending = scope.pending.get(id);
    tokenPending?.delete(pending);
    if (tokenPending?.size === 0) scope.pending.delete(id);
  }

  async function settlePending(scope: MutableScope, id?: string): Promise<void> {
    for (;;) {
      const pending =
        id === undefined
          ? [...scope.pending.values()].flatMap((values) => [...values])
          : [...(scope.pending.get(id) ?? [])];
      if (pending.length === 0) return;
      await Promise.all(pending.map(async (creation) => creation.catch(() => undefined)));
    }
  }

  function assertScopeActive(scope: MutableScope): void {
    if (scope.disposed || containerDisposed) {
      throw new CoreError('SCOPE_DISPOSED', 'The service scope has been disposed.');
    }
  }

  async function resolveInScope<T>(
    scope: MutableScope,
    token: ServiceToken<T>,
    chain: readonly string[],
  ): Promise<T> {
    assertScopeActive(scope);
    const id = tokenId(token);
    if (chain.includes(id)) {
      const cycle = [...chain.slice(chain.indexOf(id)), id];
      throw new CoreError(
        'SERVICE_CYCLE',
        `Circular service dependency detected: ${cycle.join(' -> ')}.`,
        { cycle: Object.freeze(cycle) },
      );
    }

    const registration = registrations.get(id);
    if (registration === undefined) {
      throw new CoreError('SERVICE_MISSING', `Service '${id}' is not registered.`, { tokenId: id });
    }
    if (registration.type === 'value') return registration.value as T;

    if (registration.lifetime === 'session' && scope.kind !== 'session') {
      throw new CoreError(
        'SERVICE_SESSION_SCOPE_REQUIRED',
        `Session service '${id}' cannot be resolved from the runtime scope.`,
        { tokenId: id },
      );
    }

    const cacheScope = registration.lifetime === 'runtime' ? rootScope : scope;
    const resolutionScope = registration.lifetime === 'runtime' ? rootScope : scope;
    if (registration.lifetime !== 'transient') {
      const cached = cacheScope.cache.get(id);
      if (cached !== undefined) return (await cached) as T;
    }

    const nextChain = Object.freeze([...chain, id]);
    const scopedReader: ServiceResolver = Object.freeze({
      get: <U>(dependency: ServiceToken<U>) =>
        resolveInScope(resolutionScope, dependency, nextChain),
      tryGet: async <U>(dependency: ServiceToken<U>) => {
        const dependencyId = tokenId(dependency);
        if (!registrations.has(dependencyId)) return undefined;
        return resolveInScope(resolutionScope, dependency, nextChain);
      },
    });

    const ownerScope = registration.lifetime === 'runtime' ? rootScope : scope;
    const creation = Promise.resolve().then(async () => {
      const value = await registration.factory(scopedReader);
      if (ownerScope.disposed || containerDisposed) {
        if (isDisposable(value)) await value.dispose();
        throw new CoreError(
          'SCOPE_DISPOSED',
          `Service '${id}' finished creating after its scope was disposed.`,
          { tokenId: id },
        );
      }
      ownerScope.created.push({ tokenId: id, value });
      return value;
    });
    trackPending(ownerScope, id, creation);

    if (registration.lifetime !== 'transient') {
      cacheScope.cache.set(id, creation);
      void creation.catch(() => {
        if (cacheScope.cache.get(id) === creation) cacheScope.cache.delete(id);
      });
    }
    return (await creation) as T;
  }

  function makeScope(kind: 'runtime' | 'session'): MutableScope {
    const scope: MutableScope = {
      public: undefined as unknown as ManagedServiceScope,
      kind,
      cache: new Map(),
      pending: new Map(),
      created: [],
      disposed: false,
    };
    const publicScope: ManagedServiceScope = Object.freeze({
      kind,
      get disposed(): boolean {
        return scope.disposed;
      },
      get: <T>(token: ServiceToken<T>) => resolveInScope(scope, token, []),
      tryGet: async <T>(token: ServiceToken<T>) => {
        assertScopeActive(scope);
        if (!registrations.has(tokenId(token))) return undefined;
        return resolveInScope(scope, token, []);
      },
      dispose: async () => disposeScope(scope),
    });
    scope.public = publicScope;
    scopes.push(scope);
    return scope;
  }

  async function disposeScope(scope: MutableScope): Promise<void> {
    if (scope.disposed) return;
    scope.disposed = true;
    scope.cache.clear();
    await settlePending(scope);
    const entries = scope.created.splice(0);
    try {
      await disposeCreated(entries);
    } finally {
      if (scope.kind === 'session') {
        const index = scopes.indexOf(scope);
        if (index >= 0) scopes.splice(index, 1);
      }
    }
  }

  async function removeToken(id: string, expected: Registration): Promise<void> {
    if (registrations.get(id) !== expected) return;
    registrations.delete(id);
    const ownerTokens = owned.get(expected.ownerId);
    ownerTokens?.delete(id);
    if (ownerTokens?.size === 0) owned.delete(expected.ownerId);

    const removed: CreatedService[] = [];
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index];
      if (scope !== undefined) await settlePending(scope, id);
    }
    // Reverse scope order, and reverse instance order inside disposeCreated.
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index];
      if (scope === undefined) continue;
      scope.cache.delete(id);
      for (let entryIndex = scope.created.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const entry = scope.created[entryIndex];
        if (entry?.tokenId !== id) continue;
        removed.push(entry);
        scope.created.splice(entryIndex, 1);
      }
    }
    await disposeCreated(removed.reverse());
  }

  const rootScope = makeScope('runtime');

  function addRegistration(id: string, registration: Registration): void {
    if (frozen) {
      throw new CoreError('REGISTRATION_FROZEN', 'Service registration is closed.', {
        ownerId: registration.ownerId,
      });
    }
    if (registrations.has(id)) {
      throw new CoreError('SERVICE_DUPLICATE', `Service '${id}' is already registered.`, {
        tokenId: id,
        ownerId: registration.ownerId,
      });
    }
    registrations.set(id, registration);
    let ownerTokens = owned.get(registration.ownerId);
    if (ownerTokens === undefined) {
      ownerTokens = new Set();
      owned.set(registration.ownerId, ownerTokens);
    }
    ownerTokens.add(id);
    if (registration.type === 'value') {
      rootScope.created.push({ tokenId: id, value: registration.value });
    }
  }

  return {
    root: rootScope.public,

    registrarFor(owner: string | PluginId): ServiceRegistrar {
      assertNonEmpty(owner, 'Service owner id');
      const ownerId = pluginId(owner);
      return Object.freeze({
        registerValue<T>(token: ServiceToken<T>, value: T): void {
          const id = tokenId(token);
          addRegistration(id, {
            type: 'value',
            ownerId,
            token: token as unknown as ServiceToken<unknown>,
            value,
          });
        },

        registerFactory<T>(
          token: ServiceToken<T>,
          factory: ServiceFactory<T>,
          options: { readonly lifetime?: ServiceLifetime } = {},
        ): void {
          const id = tokenId(token);
          const lifetime = options.lifetime ?? 'runtime';
          addRegistration(id, {
            type: 'factory',
            ownerId,
            token: token as unknown as ServiceToken<unknown>,
            factory,
            lifetime,
          });
        },
      });
    },

    createSessionScope(): ManagedServiceScope {
      if (containerDisposed) {
        throw new CoreError('SCOPE_DISPOSED', 'The service container has been disposed.');
      }
      return makeScope('session').public;
    },

    async removeOwner(owner: string | PluginId): Promise<void> {
      const ownerId = pluginId(owner);
      const tokens = owned.get(ownerId);
      if (tokens === undefined) return;
      const errors: unknown[] = [];
      for (const id of [...tokens].reverse()) {
        const registration = registrations.get(id);
        if (registration === undefined) continue;
        try {
          await removeToken(id, registration);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateDisposalError(errors);
    },

    freeze(): void {
      frozen = true;
    },

    get frozen(): boolean {
      return frozen;
    },

    async dispose(): Promise<void> {
      if (containerDisposed) return;
      containerDisposed = true;
      const errors: unknown[] = [];
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        const scope = scopes[index];
        if (scope === undefined) continue;
        try {
          await disposeScope(scope);
        } catch (error) {
          errors.push(error);
        }
      }
      registrations.clear();
      owned.clear();
      if (errors.length > 0) throw new AggregateDisposalError(errors);
    },
  };
}
