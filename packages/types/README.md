# `@mgravey/loom-types`

Dependency-free primitives shared by Loom.js packages: branded identifiers, lifecycle states,
cancellation, clocks, disposal, errors, and JSON value types.

```sh
pnpm add @mgravey/loom-types
```

```ts
import { pluginId, semanticVersion } from '@mgravey/loom-types';
```

Most applications receive this package transitively. Plugin and adapter authors can depend on it
directly without pulling in the runtime.

Licensed under MPL-2.0.
