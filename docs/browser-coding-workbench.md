# Browser coding workbench

The experimental workbench demonstrates `@loom/coding` on top of replaceable workspace, model,
authentication, and execution packages. It is an example application, not a new Core responsibility
and not a supported OpenAI integration.

## Trust boundary

```text
workbench page                        experimental extension
  project files ─┐                       PKCE state + callback bridge
  coding session ├─ origin approval ───> exact-origin grant
  browser runtime┤─ direct-auth ───────> refresh/access/ID credentials
                 └ <─ short-lived token  ChatGPT account routing
         └──────── direct model fetch ───────────────────────> chatgpt.com
                 └─ pre-response failure ─> extension relay ─> chatgpt.com
```

The extension owns normal ChatGPT login, the localhost callback transformation, token exchange and
refresh, and account-routing persistence. The page receives a short-lived access token plus routing
ID and starts non-auth provider requests directly. It asks the extension for a replacement shortly
before expiry and never receives refresh or ID tokens. On first contact, Chrome opens trusted
extension UI where the user must approve the exact page origin. A public HTTPS deployment must also
replace the development entries in `externally_connectable` with its exact origin; owning a domain
does not make direct page fetches pass provider CORS.

If direct `fetch` rejects before an HTTP response, the page retries the credential-free body over an
authorized extension Port and keeps that transport for the remaining tab session, including page
reloads. Browser APIs cannot distinguish CORS from other connection failures, so both use this
fallback. HTTP errors, response-stream failures, and cancellation are never retried. The configured
extension is checked automatically on page load.

The primary surface is a conversation view. Workspace operations appear as compact collapsed
activity rows with a human-readable action, purpose, and live state. A header indicator
distinguishes thinking, tool use, response writing, ready, and error states. The conversation owns
its scrolling, so the follow-up composer remains reachable during long responses. The editor and
manual runtime controls remain in a closed utility drawer until the user opens it. The same runtimes
are also exposed to the agent through a schema-described website tool, so a request to run or verify
code produces captured execution output instead of an inferred result.

Assistant Markdown is converted to safe DOM elements rather than injected as HTML. Headings, lists,
inline code, and fenced blocks receive conversation-native styling; fenced code and captured text
output include a small copy action.

## Workspace conversations

Completed turns are saved as versioned JSON records in `.loom/conversations/` when workspace write
access is enabled. Opening the workspace restores the newest conversation, and selecting another
saved conversation rebuilds the coding session with its prior user/assistant transcript so the next
turn retains context. Conversation files are excluded from QuickJS, Pyodide, and WebContainer
snapshots and preserved during runtime write-back.

The sidebar supports multiple conversations per workspace. **Delete** removes only the selected
conversation after confirmation. **Clean .loom** removes all Loom-owned workspace metadata,
including conversations and generated figures, after a broader confirmation. Read-only workspaces
can restore history but cannot create, delete, or persist conversation changes.

The browser login creates an authorization tab with PKCE and state, installs one session-scoped DNR
rule limited to that tab, and asks the provider to return to the audited
`http://localhost:1455/auth/callback`. Chrome transforms that navigation into the extension's
web-accessible `callback.html`. The callback verifies tab binding, state, expiry, and single use,
exchanges the code inside the extension, then removes the rule and transaction. No localhost server
or Node companion is used. Device code remains a manually selected fallback.

This flow reuses undocumented behavior of the open-source Codex client and remains unsupported for
third-party production use.

## Library API

`createCodingSession()` accepts an explicitly selected model, built-in workspace tools,
application-defined `CodexTool` operations, optional execution runtimes, agent configuration, and a
validated prior user/assistant transcript for resuming persisted conversations. The returned session
provides:

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
  immediately visible on disk when write access is enabled. Chrome asks for the selected read or
  read/write permission when the folder is opened; runtime execution does not prompt again.
- **Virtual memory project** — imports a folder or ZIP into an isolated in-memory filesystem. The
  browser receives no persistent permission; export a ZIP before closing the page.
- **Persistent browser project (OPFS)** — uses the same project contract and saves a bounded ZIP
  snapshot in Origin Private File System storage after mutations.

All modes support UTF-8 editing, binary-preserving snapshots, stat, mkdir, move, remove, strict
unified patches, folder import, ZIP import, and ZIP export. Imports reject absolute/traversal paths,
backslashes, NULs, symlinks, duplicates, file/directory conflicts, excessive entries, oversized
files/archives, and suspicious compression ratios. Patch application is atomic and requires exact
context; it does not search for a nearby fuzzy match.

The sidebar exposes **Read project files** and **Modify project files** controls. Disabling read
removes project discovery and execution tools. Read-only mode keeps list/read/stat and run-file
tools, removes mutation/package-install tools, disables editor/import writes, and executes runtimes
against a copied snapshot without committing their filesystem changes. Changing the policy for a
direct folder requires reopening it so Chrome can request the matching folder permission once.

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

The workbench registers `website/run-workspace-file` and `website/install-runtime-packages` with
JSON schemas and detailed descriptions. The agent chooses `quickjs`, `node`, or `python`, while the
website owns the runtime instances, workspace synchronization, output limits, persistence, and UI.

Pyodide loads NumPy and Matplotlib by default, calls `loadPackagesFromImports()` for other bundled
imports, and uses `micropip` for explicitly requested compatible registry packages. Matplotlib runs
with the Agg backend: `plt.show()` remains nonblocking, open figures are saved into `.loom/figures/`
as PNG artifacts, and the conversation renders them below the completed tool row.

WebContainer package installation uses `npm install --save`. The resulting dependency metadata and
lockfile are synchronized to the project, while `node_modules` and cache directories are excluded.
Before a later Node entrypoint runs, its `package.json` dependencies are restored inside the fresh
temporary execution root.

WebContainers require cross-origin isolation headers and allow only one live instance per page.
Production commercial use may require a StackBlitz WebContainer license. Pyodide and QuickJS should
run in dedicated Workers when hard termination is required; cooperative cancellation cannot stop all
native/WASM work immediately.

Registry dependencies are untrusted code. The tool rejects command-like requirements and arbitrary
package URLs, but npm lifecycle scripts and imported Python package code can still execute inside
their isolated runtime. Pyodide can install only pure-Python wheels or compatible wasm32/Emscripten
wheels; WebContainer cannot load ordinary native Node addons.

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
enter the extension ID. The page checks it automatically; select **Reconnect** only when needed,
approve `http://localhost:4173` in the extension options page, then reload. The origin grant
survives browser restarts until revoked; disabling the experiment clears it.

The included simple Python server is sufficient for workspace/model testing but does not emit the
COOP/COEP headers WebContainers require. Use an HTTPS server configured with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` for the
Node.js runtime. The example uses pinned CDN modules; a production build should self-host and audit
the runtime assets.

Automated tests use synthetic OAuth/model responses and injected runtime backends. They do not
contact OpenAI or require credentials.
