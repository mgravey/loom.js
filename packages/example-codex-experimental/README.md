# Experimental Codex vertical slice

This private Phase 5.5 example connects a browser-hosted Loom runtime to the separately installed
experimental extension. The extension owns ChatGPT/Codex credentials and provider network access;
the page receives only authentication state, logout acknowledgement, and sanitized model events.

This is an unsupported interoperability experiment, not a public OpenAI OAuth integration. Never
paste tokens into this page, configuration, source files, logs, or test fixtures.

## Build and run

From the repository root:

```sh
pnpm build
python3 -m http.server 4173 --directory packages
```

In `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose
`packages/extension-codex-experimental/dist`. Open the extension's options page to explicitly enable
and complete device authorization. Then open `http://localhost:4173/example-codex-experimental/`,
enter the extension ID, check authentication, and select a workspace directory.

Disabling the experiment or selecting logout deletes the extension-owned refresh credential. The
application cannot start interactive authorization and cannot read refresh or ID credentials.

For complete step-by-step instructions, automated verification, trust boundaries, and current
limitations, see the [Phase 5.5 vertical-slice guide](../../docs/phase-5-5-vertical-slice.md).
