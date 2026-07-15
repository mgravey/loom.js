import { PLUGIN_API_VERSION, type LoomPlugin } from '@loom/plugin-api';
import { LoomError, isNamespacedId, isSemanticVersion, type PluginId } from '@loom/types';

export interface ValidatedPluginGraph {
  readonly ordered: readonly LoomPlugin[];
  readonly byId: ReadonlyMap<PluginId, LoomPlugin>;
}

function dependencies(plugin: LoomPlugin): readonly PluginId[] {
  return plugin.manifest.requiredPlugins ?? [];
}

function optionalDependencies(plugin: LoomPlugin): readonly PluginId[] {
  return plugin.manifest.optionalPlugins ?? [];
}

function validateManifest(plugin: LoomPlugin): void {
  const { manifest } = plugin;
  if (!isNamespacedId(manifest.id)) {
    throw new LoomError('INVALID_ID', `Invalid plugin ID '${String(manifest.id)}'.`, {
      details: { pluginId: manifest.id },
    });
  }
  if (!isSemanticVersion(manifest.version)) {
    throw new LoomError(
      'INVALID_VERSION',
      `Plugin '${manifest.id}' has invalid version '${String(manifest.version)}'.`,
      { details: { pluginId: manifest.id, version: manifest.version } },
    );
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new LoomError(
      'PLUGIN_API_VERSION_MISMATCH',
      `Plugin '${manifest.id}' targets API ${String(manifest.apiVersion)}; Loom requires ${String(PLUGIN_API_VERSION)}.`,
      {
        details: {
          pluginId: manifest.id,
          actual: manifest.apiVersion,
          expected: PLUGIN_API_VERSION,
        },
      },
    );
  }

  const declared = new Set<string>();
  for (const dependency of [...dependencies(plugin), ...optionalDependencies(plugin)]) {
    if (!isNamespacedId(dependency)) {
      throw new LoomError(
        'INVALID_ID',
        `Plugin '${manifest.id}' declares invalid dependency '${String(dependency)}'.`,
        { details: { pluginId: manifest.id, dependency } },
      );
    }
    if (declared.has(dependency)) {
      throw new LoomError(
        'INVALID_CONFIGURATION',
        `Plugin '${manifest.id}' declares dependency '${dependency}' more than once.`,
        { details: { pluginId: manifest.id, dependency } },
      );
    }
    declared.add(dependency);
  }
}

/** Validates the complete fixed plugin set and returns a stable topological order. */
export function validatePluginGraph(plugins: readonly LoomPlugin[]): ValidatedPluginGraph {
  const byId = new Map<PluginId, LoomPlugin>();
  for (const plugin of plugins) {
    validateManifest(plugin);
    if (byId.has(plugin.manifest.id)) {
      throw new LoomError(
        'DUPLICATE_PLUGIN',
        `Plugin '${plugin.manifest.id}' is registered more than once.`,
        { details: { pluginId: plugin.manifest.id } },
      );
    }
    byId.set(plugin.manifest.id, plugin);
  }

  for (const plugin of plugins) {
    for (const dependency of dependencies(plugin)) {
      if (!byId.has(dependency)) {
        throw new LoomError(
          'MISSING_PLUGIN_DEPENDENCY',
          `Plugin '${plugin.manifest.id}' requires missing plugin '${dependency}'.`,
          { details: { pluginId: plugin.manifest.id, dependency } },
        );
      }
    }
  }

  const ordered: LoomPlugin[] = [];
  const emitted = new Set<PluginId>();
  while (ordered.length < plugins.length) {
    let progressed = false;
    for (const plugin of plugins) {
      if (emitted.has(plugin.manifest.id)) continue;
      if (!dependencies(plugin).every((dependency) => emitted.has(dependency))) continue;
      emitted.add(plugin.manifest.id);
      ordered.push(plugin);
      progressed = true;
    }
    if (!progressed) {
      const cycle = plugins
        .filter((plugin) => !emitted.has(plugin.manifest.id))
        .map((plugin) => plugin.manifest.id);
      throw new LoomError(
        'PLUGIN_DEPENDENCY_CYCLE',
        `Plugin dependency cycle detected among: ${cycle.join(', ')}.`,
        { details: { pluginIds: Object.freeze(cycle) } },
      );
    }
  }

  return Object.freeze({
    ordered: Object.freeze(ordered),
    byId,
  });
}
