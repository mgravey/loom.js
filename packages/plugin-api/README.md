# `@mgravey/loom-plugin-api`

Stable public contracts for Loom.js plugin authors, including plugin definitions, dependencies,
capabilities, services, events, and the restricted runtime view exposed during plugin lifecycle.

```sh
pnpm add @mgravey/loom-plugin-api @mgravey/loom-types
```

```ts
import type { LoomPlugin } from '@mgravey/loom-plugin-api';
```

Plugins should import these contracts instead of runtime internals. See the
[plugin authoring guide](../../docs/plugin-authoring.md).

Licensed under MPL-2.0.
