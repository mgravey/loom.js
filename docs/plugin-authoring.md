# Plugin authoring

## Contract

A plugin has a manifest and zero or more lifecycle hooks. Its manifest contains:

- a namespaced plugin ID;
- a semantic plugin version;
- the numeric Loom plugin API version;
- separate lists of required and optional plugin IDs.

Required dependencies participate in validation and lifecycle ordering. Optional dependencies are
metadata: they neither fail validation nor alter order. Resolve optional integrations during
`start`, after all plugins have initialized.

Plugin instances are fixed when the runtime is created. A Phase 1 plugin must not assume hot
installation, removal, restart, or dependency version negotiation.

## Minimal plugin

The public helper preserves hook inference while the ID constructors validate values at the
boundary:

```ts
import { pluginId, semanticVersion } from '@loom/types';
import { PLUGIN_API_VERSION, definePlugin, registerTool, type Tool } from '@loom/plugin-api';

const echo: Tool = {
  name: 'echo',
  execute(input) {
    return Promise.resolve(input);
  },
};

export const echoPlugin = definePlugin({
  manifest: {
    id: pluginId('example/echo'),
    version: semanticVersion('0.1.0'),
    apiVersion: PLUGIN_API_VERSION,
    requiredPlugins: [],
    optionalPlugins: [],
  },
  initialize(context) {
    registerTool(context.capabilities, 'example/echo-tool', echo);
  },
});
```

Applications compose through the core factory and explicitly advance the one-shot lifecycle:

```ts
import { createLoomRuntime } from '@loom/core';

const runtime = createLoomRuntime({ plugins: [echoPlugin] });
await runtime.initialize();
await runtime.start();

// Create sessions and resolve capabilities while running.

await runtime.stop();
await runtime.dispose();
```

## Lifecycle responsibilities

### `initialize`

Register capabilities and internal services. Registration is accepted only while the plugin's own
hook is executing. Avoid starting work or resolving optional integrations here.

If initialization fails, Loom removes the failing plugin's owned registrations and disposes every
plugin that initialized successfully in reverse order.

### `start`

Resolve optional capabilities/services and begin plugin work. Registries are frozen by this point.
If startup fails, Loom stops already-started plugins and disposes initialized plugins in reverse
order.

### `stop`

Stop work begun by `start`. Make the hook safe for best-effort cleanup. Loom invokes all applicable
cleanup hooks even if an earlier one fails.

### `dispose`

Release initialized resources. Disposal is terminal and should tolerate repeated cleanup paths. Loom
also removes every registration owned by the plugin.

## Capability design

Use a generic capability only for functionality consumers should discover. Use DI services for
private collaboration inside an implementation. Capability identity is `(kind, namespaced ID)`; do
not depend on constructor identity or use an unnamespaced shorthand.

Provider-neutral contracts should describe the smallest behavior callers need:

- authentication returns an access token without exposing a provider flow;
- models accept a generic request and stream generic output events;
- tools execute a generic request;
- agent factories receive a model, tools, optional memory, and immutable configuration;
- agents stream generic run events;
- execution runtimes execute generic requests;
- storage is asynchronous, namespaced, and byte-oriented;
- memory, platform, and UI remain generic extension points until later protocols are proven.

Do not expose provider wire formats through the core contracts. A provider plugin can offer richer
types in its own package without making them runtime dependencies.

The key and registration helpers preserve specialized request/event types. Export one canonical
typed key from the package that owns a richer protocol so consumers do not reconstruct the same
structural key with an incompatible compile-time type.

## Configuration

Plugin configuration must be JSON data. Loom clones and freezes it before hooks receive it. A plugin
receives only the value under its own ID, so it must not inspect another plugin's private
configuration.

Session configuration may replace a plugin's runtime configuration. Treat configuration as a value,
not a mutable settings service: there are no watchers, schemas, mutation, or hot reload in Phase 1.

## Environment constraints

Published source in Phase 1 is environment-neutral:

- do not access DOM, browser extension, filesystem, or Node APIs;
- do not import concrete providers or runtimes into core packages;
- use Loom's cancellation, clock, disposal, and error abstractions;
- emit ESM and declarations through explicit package exports;
- use only public Loom exports—never `src` or other internal paths.

Environment-specific plugins may compile against their target environment, but Loom Core must remain
portable. Accept host primitives explicitly rather than reading ambient globals as defaults. This
keeps capability installation deliberate and makes window, worker, and test composition
deterministic.

The Phase 2 workspace plugin is still environment-neutral: it accepts a `TextWorkspace` adapter and
does not call a host filesystem API. Agent plugins should likewise receive models, tools, optional
memory, and immutable configuration rather than resolving provider implementations internally.

The Phase 3 IndexedDB and File System Access packages are concrete browser leaves. Permission
pickers stay in applications because they require user interaction; a workspace plugin receives the
resulting directory handle and never broadens that authority.

## Checklist

- [ ] Manifest ID and all capability IDs are namespaced.
- [ ] Required and optional dependencies are declared separately.
- [ ] Registration occurs only in `initialize`.
- [ ] Optional integration is resolved in `start`.
- [ ] Cleanup is deterministic and safe after partial startup.
- [ ] Capability selection uses explicit IDs.
- [ ] Configuration and event payloads are treated as immutable.
- [ ] Imports respect package and environment boundaries.
- [ ] Tests cover successful lifecycle and rollback behavior.
