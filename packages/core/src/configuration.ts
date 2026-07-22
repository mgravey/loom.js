import type {
  DeepReadonly,
  JsonArray,
  JsonObject,
  JsonValue,
  RuntimeConfiguration as LoomRuntimeConfiguration,
  SessionConfigurationOverlay,
} from '@mgravey/loom-types';

import { CoreError } from './errors.js';
import { assertNonEmpty } from './internal.js';

export type RuntimeConfigurationInput =
  LoomRuntimeConfiguration | Readonly<Record<string, JsonObject>>;

export interface PluginConfigurationView {
  readonly pluginId: string;
  get(): DeepReadonly<JsonObject>;
}

export interface ConfigurationStore {
  readonly pluginIds: readonly string[];
  forPlugin(pluginId: string): PluginConfigurationView;
  createOverlay(
    overrides: SessionConfigurationOverlay | RuntimeConfigurationInput,
  ): ConfigurationStore;
  snapshot(): DeepReadonly<LoomRuntimeConfiguration>;
}

const EMPTY_CONFIGURATION: DeepReadonly<JsonObject> = deepFreeze({});

function invalid(path: string, reason: string): never {
  throw new CoreError(
    'CONFIGURATION_INVALID',
    `Invalid JSON configuration at '${path}': ${reason}.`,
    { path, reason },
  );
}

function cloneJson(value: JsonValue, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') invalid(path, `unsupported value type '${typeof value}'`);

  const objectValue = value as object;
  if (ancestors.has(objectValue)) invalid(path, 'cyclic values are not supported');
  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const array = value as JsonArray;
      const result: JsonValue[] = [];
      for (let index = 0; index < array.length; index += 1) {
        const itemPath = `${path}[${String(index)}]`;
        if (!(index in array)) invalid(itemPath, 'sparse arrays are not valid JSON');
        const item = array[index];
        if (item === undefined) invalid(itemPath, 'undefined is not valid JSON');
        result.push(cloneJson(item, itemPath, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(path, 'objects must have a plain or null prototype');
    }
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) {
      result[key] = cloneJson(
        (value as Record<string, JsonValue>)[key] as JsonValue,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(objectValue);
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}

function cloneConfiguration(value: JsonObject, pluginId: string): DeepReadonly<JsonObject> {
  return deepFreeze(cloneJson(value, pluginId, new Set()) as JsonObject);
}

function unknownPlugin(pluginId: string): never {
  throw new CoreError(
    'CONFIGURATION_UNKNOWN_PLUGIN',
    `Configuration was provided for unknown plugin '${pluginId}'.`,
    { pluginId },
  );
}

/**
 * Validates, clones, and deeply freezes plugin configuration. Views expose only
 * one plugin's value, preventing accidental cross-plugin configuration access.
 */
export function createConfigurationStore(
  configuration: RuntimeConfigurationInput | undefined,
  knownPluginIds: Iterable<string>,
): ConfigurationStore {
  const known = [...knownPluginIds];
  const knownSet = new Set<string>();
  for (const pluginId of known) {
    assertNonEmpty(pluginId, 'Plugin id');
    knownSet.add(pluginId);
  }

  const values = new Map<string, DeepReadonly<JsonObject>>();
  for (const [pluginId, value] of Object.entries(configuration ?? {})) {
    if (!knownSet.has(pluginId)) unknownPlugin(pluginId);
    values.set(pluginId, cloneConfiguration(value, pluginId));
  }

  function createStore(current: ReadonlyMap<string, DeepReadonly<JsonObject>>): ConfigurationStore {
    return Object.freeze({
      pluginIds: Object.freeze([...known]),

      forPlugin(pluginId: string): PluginConfigurationView {
        if (!knownSet.has(pluginId)) unknownPlugin(pluginId);
        return Object.freeze({
          pluginId,
          get: () => current.get(pluginId) ?? EMPTY_CONFIGURATION,
        });
      },

      createOverlay(
        overrides: SessionConfigurationOverlay | RuntimeConfigurationInput,
      ): ConfigurationStore {
        const next = new Map(current);
        for (const [pluginId, value] of Object.entries(overrides)) {
          if (!knownSet.has(pluginId)) unknownPlugin(pluginId);
          next.set(pluginId, cloneConfiguration(value, pluginId));
        }
        return createStore(next);
      },

      snapshot(): DeepReadonly<LoomRuntimeConfiguration> {
        const result: Record<string, DeepReadonly<JsonObject>> = {};
        for (const pluginId of known) {
          const value = current.get(pluginId);
          if (value !== undefined) result[pluginId] = value;
        }
        return deepFreeze(result);
      },
    });
  }

  return createStore(values);
}
