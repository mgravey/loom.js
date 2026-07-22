# `@mgravey/loom-auth-extension`

Website-side Chrome extension communication for Loom.js authentication. It wraps an explicitly
supplied external-message transport, validates broker responses, and exposes a Loom `AuthProvider`
plugin adapter.

```sh
pnpm add @mgravey/loom-auth-extension
```

```ts
import { createExtensionAuthPlugin } from '@mgravey/loom-auth-extension';
```

This package does not access Chrome globals implicitly and does not store refresh credentials. Pair
it with a trusted extension based on `@mgravey/loom-extension`.

See the [credential broker guide](../../docs/credential-broker.md).

Licensed under MPL-2.0.
