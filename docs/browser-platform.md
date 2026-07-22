# Browser platform plugins

Phase 3 supplies browser-hosted implementations without adding browser knowledge to Loom Core. The
browser layer consists of three independent packages:

- `@mgravey/loom-platform-browser` registers explicitly supplied browser host primitives as a typed
  platform capability;
- `@mgravey/loom-storage-indexeddb` implements Loom's namespaced byte storage contract with
  IndexedDB;
- `@mgravey/loom-workspace-fsa` implements the Phase 2 text-workspace tools over a supplied
  `FileSystemDirectoryHandle`.

The packages compile against browser typings, but their dependencies still point only toward public
Loom contracts. They do not import core, an agent, a model provider, authentication, or an execution
runtime.

## Explicit host injection

Browser plugins receive host objects in their factory options. They do not read `window`,
`navigator`, `indexedDB`, or another global as a hidden default, and they do not infer a preferred
implementation from feature detection. The application decides which capabilities exist and
registers the corresponding plugins.

This boundary also makes window and worker composition equivalent: a window passes its own host
objects, while a dedicated worker passes the objects available in that worker. Missing host support
is an application-level composition decision rather than a fallback inside Loom.

## IndexedDB storage

The IndexedDB plugin stores copied byte values under a compound `(namespace, key)` identity. Its
public behavior follows the existing `Storage` contract:

- `get` returns a fresh byte copy or `undefined`;
- `set` creates or replaces a value;
- `delete` reports whether a value existed;
- `list` returns a deterministic snapshot of keys for one namespace.

The database opens lazily on the first storage operation, then creates or validates its schema
before serving that operation. The connection closes during plugin disposal. Database names and the
`IDBFactory` are supplied explicitly so tests, applications, and multiple runtimes control
persistence boundaries.

## File System Access workspace

The workspace plugin starts from a caller-supplied directory handle. It never opens a directory
picker; requesting permission requires a user gesture and therefore belongs in the application UI.
Validated Loom workspace paths are traversed relative to that handle, so absolute and parent paths
never reach the browser API.

Phase 3 retains the narrow Phase 2 behavior:

- list immediate directory entries;
- read UTF-8 text files;
- create or replace UTF-8 text files.

Directory creation, deletion, renaming, binary files, recursive traversal, permission persistence,
and conflict resolution remain deferred. The same adapter can operate on a directory selected by a
user or on an OPFS directory handle supplied by an application.

## Browser application flow

A browser application owns the permission and composition sequence:

1. obtain a directory handle from a user gesture or another browser storage API;
2. construct the browser platform, IndexedDB storage, and workspace plugins with explicit host
   objects;
3. create and start a Loom runtime;
4. resolve the agent, model, storage, and workspace tools by explicit keys;
5. create a session and pass its cancellation context through the agent run;
6. close the session and dispose the runtime before dropping the directory handle.

The included browser example uses the deterministic scripted model. It demonstrates platform
composition, not a production model or authentication flow.

Build and serve it from the repository root:

```sh
pnpm --filter @mgravey/loom-example-browser build
python3 -m http.server 4173 --directory packages/example-browser
```

Open `http://localhost:4173` and choose a directory containing a UTF-8 `source.txt`. The application
creates or replaces `result.txt`, then closes its session and disposes the runtime. See the
[example README](../packages/example-browser/README.md) for the complete flow.

## Security and lifecycle

- A directory handle defines the workspace authority; no tool can escape it through a Loom path.
- The application remains responsible for requesting and explaining browser permissions.
- Byte arrays and list results cross plugin boundaries as immutable snapshots or copies.
- Cancellation is checked before and after workspace operations and forwarded through the existing
  `OperationContext`.
- Runtime disposal closes browser-owned connections created by plugins, but it does not revoke a
  directory permission owned by the browser.
