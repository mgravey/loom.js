import type {
  CapabilityEntry,
  CapabilityKey,
  CapabilityKind,
  CapabilityRegistrar,
  CapabilityRegistryReader,
} from '@loom/plugin-api';
import { pluginId, type CapabilityId, type PluginId } from '@loom/types';

import { CoreError } from './errors.js';
import { assertNonEmpty } from './internal.js';

export interface CapabilityRegistryController {
  readonly reader: CapabilityRegistryReader;
  registrarFor(ownerId: string | PluginId): CapabilityRegistrar;
  removeOwner(ownerId: string | PluginId): void;
  freeze(): void;
  readonly frozen: boolean;
}

export interface CapabilityRegistryChange {
  readonly owner: PluginId;
  readonly key: CapabilityKey<unknown>;
  readonly action: 'registered' | 'removed';
}

interface MutableRecord {
  readonly key: { readonly kind: CapabilityKind; readonly id: CapabilityId };
  readonly value: unknown;
  readonly ownerId: PluginId;
}

function compositeKey<T>(key: CapabilityKey<T>): string {
  assertNonEmpty(key.kind, 'Capability kind');
  assertNonEmpty(key.id, 'Capability id');
  // Length-prefixing prevents delimiter collisions without restricting valid IDs.
  return `${String(key.kind.length)}:${key.kind}${key.id}`;
}

/** Creates a runtime-local capability registry with an owner-aware write side. */
export function createCapabilityRegistry(
  onChange: (change: CapabilityRegistryChange) => void = () => undefined,
): CapabilityRegistryController {
  const records = new Map<string, MutableRecord>();
  const owned = new Map<string, Set<string>>();
  let frozen = false;

  const reader: CapabilityRegistryReader = Object.freeze({
    get<T>(key: CapabilityKey<T>): T {
      const value = records.get(compositeKey(key));
      if (value === undefined) {
        throw new CoreError(
          'CAPABILITY_MISSING',
          `Capability '${key.kind}:${key.id}' is not registered.`,
          { kind: key.kind, id: key.id },
        );
      }
      return value.value as T;
    },

    tryGet<T>(key: CapabilityKey<T>): T | undefined {
      return records.get(compositeKey(key))?.value as T | undefined;
    },

    has<T>(key: CapabilityKey<T>): boolean {
      return records.has(compositeKey(key));
    },

    list(kind?: CapabilityKind): readonly CapabilityEntry[] {
      if (kind !== undefined) assertNonEmpty(kind, 'Capability kind');
      const snapshot: CapabilityEntry[] = [];
      for (const record of records.values()) {
        if (kind === undefined || record.key.kind === kind) {
          snapshot.push(
            Object.freeze({
              key: record.key,
              value: record.value,
              owner: record.ownerId,
            }),
          );
        }
      }
      return Object.freeze(snapshot);
    },
  });

  function remove(composite: string, expected: MutableRecord): void {
    if (records.get(composite) !== expected) return;
    records.delete(composite);
    const ownerRecords = owned.get(expected.ownerId);
    ownerRecords?.delete(composite);
    if (ownerRecords?.size === 0) owned.delete(expected.ownerId);
    onChange({
      owner: expected.ownerId,
      key: expected.key,
      action: 'removed',
    });
  }

  return {
    reader,

    registrarFor(owner: string | PluginId): CapabilityRegistrar {
      assertNonEmpty(owner, 'Capability owner id');
      const ownerId = pluginId(owner);
      return Object.freeze({
        register<T>(key: CapabilityKey<T>, value: T): void {
          if (frozen) {
            throw new CoreError('REGISTRATION_FROZEN', 'Capability registration is closed.', {
              ownerId,
            });
          }
          const composite = compositeKey(key);
          if (records.has(composite)) {
            throw new CoreError(
              'CAPABILITY_DUPLICATE',
              `Capability '${key.kind}:${key.id}' is already registered.`,
              { kind: key.kind, id: key.id, ownerId },
            );
          }

          const record: MutableRecord = {
            key,
            value,
            ownerId,
          };
          records.set(composite, record);
          let ownerRecords = owned.get(ownerId);
          if (ownerRecords === undefined) {
            ownerRecords = new Set();
            owned.set(ownerId, ownerRecords);
          }
          ownerRecords.add(composite);
          onChange({
            owner: ownerId,
            key: key as CapabilityKey<unknown>,
            action: 'registered',
          });
        },
      });
    },

    removeOwner(owner: string | PluginId): void {
      const ownerId = pluginId(owner);
      const ownerRecords = owned.get(ownerId);
      if (ownerRecords === undefined) return;
      for (const composite of [...ownerRecords]) {
        const record = records.get(composite);
        if (record !== undefined) remove(composite, record);
      }
    },

    freeze(): void {
      frozen = true;
    },

    get frozen(): boolean {
      return frozen;
    },
  };
}
