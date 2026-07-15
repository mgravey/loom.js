# Loom browser example

This private example composes the provider-neutral Codex-style agent with explicitly supplied
browser capabilities. It does not use authentication, a remote model provider, an extension, or an
execution runtime.

## Prerequisites

- A browser that supports the File System Access API and IndexedDB.
- A secure context (`https://` or a browser-recognized local development origin).
- A directory containing a UTF-8 file named `source.txt`.

The scripted model lists the chosen directory, reads `source.txt`, and creates or replaces
`result.txt`.

## Build and run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @loom/example-browser build
python3 -m http.server 4173 --directory packages/example-browser
```

Then open <http://localhost:4173>, select **Choose directory and run**, and grant read/write access
to the prepared directory. Any static HTTP server can replace the Python command.

Each button click creates a fresh Loom runtime and caller-supplied session. The session and runtime
are disposed after success or failure.
