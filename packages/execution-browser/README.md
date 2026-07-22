# `@mgravey/loom-execution-browser`

Credential-free browser execution adapters for QuickJS/WASM, WebContainers, and Pyodide.

The package lazy-loads every optional runtime. Its public execution request deliberately has no
environment, HTTP-header, token, cookie, or host-callback field. Imported projects receive only a
copied filesystem snapshot, command arguments, and streamed text output. Embedding applications must
keep credentials and provider transports in a separate trusted realm.

QuickJS and Pyodide should run in dedicated workers. WebContainer processes run in their own browser
runtime and must never be given secrets through files or process environment variables.

The default loader uses a native dynamic import so runtimes stay out of the main bundle.
Applications whose bundler does not resolve variable dynamic imports should supply `loadModule` with
a literal dynamic import or an import-map entry. Pyodide hard cancellation should terminate its
dedicated worker; its interrupt buffer and adapter timeout are best-effort fallbacks for cooperative
execution.

Licensed under MPL-2.0.
