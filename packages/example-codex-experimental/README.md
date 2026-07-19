# Loom.js welcome site and experimental Codex vertical slice

This package contains three deliberately separate browser surfaces:

- `index.html` introduces the provider-neutral Loom.js library and its potential;
- `docs.html` provides step-by-step onboarding from repository setup through custom capabilities;
- `workbench.html` runs the experimental ChatGPT-backed composition.
- `install.html`, `privacy.html`, `terms.html`, `legal.html`, and `support.html` provide the
  unpacked installation and future Store-facing policy/support surfaces.

The private example is a multi-mode browser coding workbench built on `@loom/coding`. The extension
owns ChatGPT/Codex login, credentials, account routing, and provider network access; the page
receives only authentication state, logout acknowledgement, the requested provider response stream,
and sanitized failure metadata. It cannot request access tokens.

This is an unsupported interoperability experiment, not a public OpenAI OAuth integration. Never
paste tokens into this page, configuration, source files, logs, or test fixtures.

The current checkout's observed unpacked ID is `foofdcgdelahbdgdfgocoeajdodhjbjo`. The site reads it
from `deployment-config.js`; replace it with the permanent ID allocated by the first Chrome Web
Store draft before deploying the production site. Another checkout may receive a different unpacked
ID, so `chrome://extensions` remains authoritative.

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
launch `http://localhost:4173/example-codex-experimental/workbench.html`. Enter the extension ID and
choose a direct directory, virtual memory project, or persistent OPFS project. Folder and ZIP import
plus ZIP export are available for every mode.

The workbench defaults to `gpt-5.6-sol` and uses the current Responses Lite input-item envelope for
GPT-5.6 model IDs. Other model IDs use the classic Responses request. Both remain audited,
unsupported compatibility paths rather than documented Platform API contracts.

QuickJS, WebContainer Node.js, and Pyodide Python execution receive only project snapshots and
command arguments. Credentials never enter a runtime. See the
[browser workbench guide](../../docs/browser-coding-workbench.md) for runtime hosting headers,
isolation constraints, project synchronization, and security limits.

By default, the refresh credential and routing ID are cleared when Chrome exits. The extension
options offer **Remember sign-in on this Chrome profile** after a private-computer warning; this
moves that pair to trusted local extension storage until the option is disabled, logout/experiment
disable occurs, the provider rejects it, extension data is cleared, or the extension is uninstalled.
Local deletion does not itself revoke a provider-side grant. The application cannot start
authorization or read/request provider credentials.

For complete step-by-step instructions, automated verification, trust boundaries, and current
limitations, see the [Phase 5.5 vertical-slice guide](../../docs/phase-5-5-vertical-slice.md).
