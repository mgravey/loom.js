# Browser coding workbench

The experimental workbench demonstrates `@loom/coding` on top of replaceable workspace, model,
authentication, and execution packages. It is an example application, not a new Core responsibility
and not a supported OpenAI integration.

## Trust boundary

```text
workbench page                        experimental extension
  project files ─┐                       PKCE state + callback bridge
  coding session ├─ credential-free ───> refresh/access/ID credentials
  browser runtime┘   model envelope      ChatGPT account routing
                      <── SSE chunks ─── authenticated provider fetch
```

The extension owns normal ChatGPT login, the localhost callback transformation, token exchange and
refresh, account routing, every request to the ChatGPT Codex backend, and response streaming. The
page receives status, sanitized errors, and model bytes. It never receives access, refresh, or ID
tokens. A public HTTPS deployment must replace the development entries in `externally_connectable`
with its exact origin; owning a domain does not make direct page fetches pass provider CORS.

The browser login creates an authorization tab with PKCE and state, installs one session-scoped DNR
rule limited to that tab, and asks the provider to return to the audited
`http://localhost:1455/auth/callback`. Chrome transforms that navigation into the extension's
web-accessible `callback.html`. The callback verifies tab binding, state, expiry, and single use,
exchanges the code inside the extension, then removes the rule and transaction. No localhost server
or Node companion is used. Device code remains a manually selected fallback.

This flow reuses undocumented behavior of the open-source Codex client and remains unsupported for
third-party production use.

## Library API

`createCodingSession()` accepts an explicitly selected model, workspace tools, optional execution
runtimes, and agent configuration. The returned session provides:

- `submit()` and `followUp()` streamed agent events;
- immutable transcript snapshots and event subscriptions;
- one active operation at a time;
- `cancel()` for the active model/tool/runtime operation;
- `execute()` for an injected provider-neutral execution runtime; and
- deterministic `dispose()`.

The coding package depends on public Loom contracts but does not import Chrome, DOM, provider, or
runtime-engine APIs.

## Project modes

The example's workspace selector offers:

- **Direct selected directory** — works against a user-approved File System Access handle. Edits are
  immediately visible on disk. Runtime write-back asks for confirmation first.
- **Virtual memory project** — imports a folder or ZIP into an isolated in-memory filesystem. The
  browser receives no persistent permission; export a ZIP before closing the page.
- **Persistent browser project (OPFS)** — uses the same project contract and saves a bounded ZIP
  snapshot in Origin Private File System storage after mutations.

All modes support UTF-8 editing, binary-preserving snapshots, stat, mkdir, move, remove, strict
unified patches, folder import, ZIP import, and ZIP export. Imports reject absolute/traversal paths,
backslashes, NULs, symlinks, duplicates, file/directory conflicts, excessive entries, oversized
files/archives, and suspicious compression ratios. Patch application is atomic and requires exact
context; it does not search for a nearby fuzzy match.

## Browser runtimes

`@loom/execution-browser` provides lazy adapters for:

- `quickjs-emscripten` for JavaScript/WASM evaluation;
- `@webcontainer/api` for Node.js commands; and
- Pyodide for Python.

Each invocation receives only command arguments, working directory, timeout, cancellation, and a
project snapshot. The contract deliberately has no environment map, cookies, headers, credentials,
or host `fetch` callback. Output is streamed to the host and the resulting project is synchronized
back. `node_modules`, `.venv`, `__pycache__`, `.pytest_cache`, and `.cache` are excluded from
write-back by the example.

WebContainers require cross-origin isolation headers and allow only one live instance per page.
Production commercial use may require a StackBlitz WebContainer license. Pyodide and QuickJS should
run in dedicated Workers when hard termination is required; cooperative cancellation cannot stop all
native/WASM work immediately.

## Build and run

```sh
pnpm install --frozen-lockfile
pnpm build
python3 -m http.server 4173 --directory packages
```

Load `packages/extension-codex-experimental/dist` as an unpacked extension, open its options page,
enable the experiment, and choose **Sign in with ChatGPT** or **Use device-code fallback**. Then
open <http://localhost:4173/example-codex-experimental/>, review the library introduction and
onboarding guide, then launch <http://localhost:4173/example-codex-experimental/workbench.html> and
enter the extension ID.

The included simple Python server is sufficient for workspace/model testing but does not emit the
COOP/COEP headers WebContainers require. Use an HTTPS server configured with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` for the
Node.js runtime. The example uses pinned CDN modules; a production build should self-host and audit
the runtime assets.

Automated tests use synthetic OAuth/model responses and injected runtime backends. They do not
contact OpenAI or require credentials.
