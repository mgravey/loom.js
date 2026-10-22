# Loom.js site and ChatGPT workbench

This package contains the Loom.js library welcome site, documentation, and a browser coding
workbench. The workbench has one connection: **Continue with ChatGPT**. Extension and custom-server
adapters remain separate library integrations, with no connection controls in this workbench.

## Build and run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:chatgpt
```

Open the printed `http://127.0.0.1:4174/example-codex-experimental/workbench.html` URL. Use
`LOOM_BROWSER_PORT=4175 pnpm dev:chatgpt` if the default port is occupied.

1. Click **Continue with ChatGPT** and finish the account and plan consent on OpenAI's page.
2. Once the account is verified, choose an available model. **Refresh models** retries discovery.
3. Open a local folder, temporary browser project, or persistent browser project, then send a
   prompt.

The sidebar presents account, workspace and conversation controls. The main panel keeps chat,
model/reasoning selection and the composer together; files and execution tools are in the drawer.
The layout adapts to narrow screens, and sign-in errors stay visible beside the login button. Saved
account choices appear only after a registration exists. A saved registration does not prove that
authentication succeeded. Old conversations retain their transcript, but require a newly selected
ChatGPT model before another request.

## Browser-only authentication boundaries

OAuth tokens remain in memory in the user's tab. Reloading requires signing in again. Only public
registration metadata and interface preferences persist in browser storage. The loopback server
serves static files, including the callback, and never exchanges tokens or proxies model requests.
No API key or extension setup is required.

This remains an experimental local compatibility test. Observed OpenAI discovery/JWKS CORS failures
block browser identity verification; Business authorization has also returned an organization policy
denial. A popup closing is not evidence of success. Tests use local fixtures, not live account
credentials. See
[setup and current limitations](../../docs/codex-auth-experiment.md#extension-free-sign-in-with-chatgpt).

The GitHub Pages workflow publishes the static site, but public HTTPS sign-in has not been verified
or enabled by the loopback integration. Never paste tokens into source, logs, or fixtures.

## Workspace and execution

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
