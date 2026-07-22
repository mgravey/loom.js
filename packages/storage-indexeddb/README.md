# `@mgravey/loom-storage-indexeddb`

Namespaced byte storage backed by IndexedDB, with a Loom.js plugin adapter.

```sh
pnpm add @mgravey/loom-storage-indexeddb
```

The package is browser-only and requires an IndexedDB-capable origin. Namespaces isolate logical
consumers; applications remain responsible for data lifecycle and user-facing storage policy.

Licensed under MPL-2.0.
