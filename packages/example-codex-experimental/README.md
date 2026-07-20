# Loom.js welcome site and experimental Codex vertical slice

This package contains three deliberately separate browser surfaces:

- `index.html` introduces the provider-neutral Loom.js library and its potential;
- `docs.html` provides step-by-step onboarding from repository setup through custom capabilities;
- `workbench.html` runs the experimental ChatGPT-backed composition.
- `install.html`, `privacy.html`, `terms.html`, `legal.html`, and `support.html` provide the
  unpacked installation and future Store-facing policy/support surfaces.

The GitHub Pages workflow publishes these static surfaces at <https://mgravey.com/loom.js/>. The
workbench is available at <https://mgravey.com/loom.js/workbench.html> after the Pages deployment
succeeds.

The private example is a multi-mode browser coding workbench built on `@loom/coding`. The extension
owns ChatGPT/Codex login, refresh credentials, ID-token parsing, and account-routing persistence.
For a model run it returns a short-lived access token plus the routing ID to the exact authorized
workbench origin, which starts with direct non-auth provider requests. The page renews that
credential through the extension shortly before expiry. If direct `fetch` fails before an HTTP
response, the credential-free body is retried through the extension relay and later turns or reloads
in the same tab stay on that relay. HTTP errors and cancellation are not retried. Refresh and ID
tokens remain extension-only.

This is an unsupported interoperability experiment, not a public OpenAI OAuth integration. Never
paste tokens into this page, configuration, source files, logs, or test fixtures.

The current checkout's observed unpacked ID is `foofdcgdelahbdgdfgocoeajdodhjbjo`. The site reads it
from the development `deployment-config.js`. Another checkout may receive a different unpacked ID,
so `chrome://extensions` remains authoritative. Production Pages artifacts default to the assigned
Store ID `gdcebopdllcifgleoefgbobdopiaholg` and attempt that connection on page load.

## Build and run

From the repository root:

```sh
pnpm build
python3 -m http.server 4173 --directory packages
```

In `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose
`packages/extension-codex-experimental/dist`. Open the extension's options page, enable the
experiment, then choose normal **Sign in with ChatGPT** or the device-code fallback. Open the
welcome page at `http://localhost:4173/example-codex-experimental/`, follow its documentation, then
launch `http://localhost:4173/example-codex-experimental/workbench.html`. Enter the extension ID;
the page checks it automatically, with **Reconnect** available when needed. First contact opens
trusted extension options; approve the exact `http://localhost:4173` origin there, return to the
workbench, and reload. Then choose a direct directory, virtual memory project, or persistent OPFS
project. Folder and ZIP import plus ZIP export are available for every mode.

The workbench defaults to `gpt-5.6-sol` and uses the current Responses Lite input-item envelope for
GPT-5.6 model IDs, including `reasoning.context: "all_turns"` and disabled parallel tool calls.
Other model IDs use the classic Responses request. Both remain audited, unsupported compatibility
paths rather than documented Platform API contracts.

QuickJS, WebContainer Node.js, and Pyodide Python execution receive only project snapshots and
command arguments. Credentials never enter a runtime. The workbench registers those runtimes as the
schema-described `website/run-workspace-file` tool, so the agent can execute a requested file and
return its real exit code, stdout, and stderr. Pyodide loads packages referenced by imports,
preloads NumPy and Matplotlib, and captures open figures as PNG images shown in the conversation.
The companion `website/install-runtime-packages` tool installs compatible Python wheels through
micropip or Node dependencies through npm. Node dependency metadata persists, while `node_modules`
is restored inside each temporary execution root instead of entering project storage. Manual
execution controls and the editor remain inside a closed drawer while the primary UI stays focused
on chat. Human-readable tool rows and a header activity indicator show ongoing work without
expanding raw tool payloads. The conversation scrolls independently, keeping the composer visible
for follow-up commands. Sidebar read/write controls determine the agent's tool set: read-only runs
use copied snapshots and discard filesystem changes, while Chrome requests the selected folder
permission once when it is opened. Multiple resumable chats are stored as bounded JSON records in
`.loom/conversations/`; sidebar controls create, switch, delete, or clean this Loom-owned metadata.
Conversation records are excluded from runtime snapshots. See the
[browser workbench guide](../../docs/browser-coding-workbench.md) for runtime hosting headers,
isolation constraints, project synchronization, and security limits.

By default, the refresh credential and routing ID are cleared when Chrome exits. The extension
options offer **Remember sign-in on this Chrome profile** after a private-computer warning; this
moves that pair to trusted local extension storage until the option is disabled, logout/experiment
disable occurs, the provider rejects it, extension data is cleared, or the extension is uninstalled.
Local deletion does not itself revoke a provider-side grant. The application cannot start
authorization or receive refresh/ID tokens, but direct model mode does receive a short-lived access
token in page memory. Website access is a separate exact-origin grant stored by the extension until
revoked or the experiment is disabled. Do not run untrusted scripts in an approved origin.

For complete step-by-step instructions, automated verification, trust boundaries, and current
limitations, see the [Phase 5.5 vertical-slice guide](../../docs/phase-5-5-vertical-slice.md).
