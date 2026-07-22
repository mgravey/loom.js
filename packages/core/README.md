# `@mgravey/loom-core`

Provider-neutral runtime composition for Loom.js. Core validates plugin dependencies, starts and
stops plugins deterministically, and owns capability, service, event, configuration, and session
registries.

```sh
pnpm add @mgravey/loom-core
```

```ts
import { createLoomRuntime } from '@mgravey/loom-core';

const runtime = createLoomRuntime({ plugins });
await runtime.start();
```

Core deliberately contains no Chrome, browser, model-provider, or credential transport APIs. Use
`@mgravey/loom-auth-extension` for the website side of Chrome extension communication and
`@mgravey/loom-extension` for the extension-side credential broker.

See the [architecture guide](../../docs/architecture.md) and
[plugin authoring guide](../../docs/plugin-authoring.md).

Licensed under MPL-2.0.
