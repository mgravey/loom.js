# `@mgravey/loom-tool-workspace`

Validated project-workspace contracts and coding tools for Loom.js. It includes an in-memory
adapter, normalized paths, safe ZIP import/export, strict patches, and text/binary project tools.

```sh
pnpm add @mgravey/loom-tool-workspace
```

```ts
import { createMemoryProjectWorkspace } from '@mgravey/loom-tool-workspace';

const workspace = createMemoryProjectWorkspace({
  'README.md': '# Project\n',
});
```

Treat imported archives and model-provided patches as untrusted input; the exported validators are
the intended boundary.

Licensed under MPL-2.0.
