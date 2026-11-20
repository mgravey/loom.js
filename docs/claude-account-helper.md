# Claude account helper (experimental)

This adds a **Claude account** option alongside ChatGPT, Google account, and API-key providers. It
requires Node 20.19+ and a current, unmodified
[Claude Code installation](https://code.claude.com/docs/en/setup). Companion does not implement
Claude OAuth or collect its credentials.

1. Build/reload Companion 0.8.0, or load the unpacked extension build.
2. Start `node scripts/claude-code-helper.mjs` in this checkout. Keep it running.
3. In Companion's Model servers selector choose **Claude account (local Claude Code helper)**.
4. Set a connection ID/name, keep `http://127.0.0.1:43187/v1/`, and paste the pairing token printed
   by the helper into **Helper pairing token**. Treat this token as a secret.
5. Click **Sign in with Claude Code** and complete the official browser login. If the CLI cannot
   launch the browser here, run `claude auth login` in your terminal instead.
6. Save the connection, refresh models in an approved website, and select its server-prefixed model.

Stopping/restarting the helper invalidates the pairing token; update the saved connection with the
new token. Remove the saved connection using its Remove button. **Sign out of Claude Code** signs
out the official local client, including other applications using that account.

The helper binds only to loopback. Companion stores only its pairing token. Official account
credentials remain with Claude Code. Approved websites access models through Companion's existing
origin approval and cannot obtain either credential. No arbitrary command or authenticated URL
forwarding endpoint is provided.

`LOOM_CLAUDE_HELPER_PORT` changes the default port, `LOOM_CLAUDE_BINARY` selects an installed
official binary, and `LOOM_CLAUDE_MODELS` sets comma-separated model aliases (default
`sonnet,opus,haiku`). The catalogue checks login each time but these are configured aliases, not
verified account model entitlements. The provider may reject an unavailable model.

Generation passes the complete portable text/tool transcript on stdin to a fresh CLI process.
Built-in tools and MCP are disabled; safe mode and an empty temporary working directory isolate
project customizations. Managed Claude Code policies still apply. Loom executes returned tool
requests, and the helper never automatically retries generation. Native encrypted reasoning and
provider-specific continuation items are rejected. Responses are buffered JSON; native streaming,
multimodal input and compaction are not supported by this helper.

Commands have bounded deadlines (login 180 seconds, status 15 seconds, generation 300 seconds),
request/output limits and cancellation. Companion may impose a shorter overall deadline. CLI stderr
and raw error bodies are not returned or logged. Only one helper operation runs at a time.

## Evidence and remaining verification

Reviewed 2026-09-14:
[Anthropic's integration rules](https://code.claude.com/docs/en/legal-and-compliance) distinguish
running unmodified Claude Code from third-party collection of Claude account OAuth tokens. The
[official CLI reference](https://code.claude.com/docs/en/cli-reference) documents authentication,
print mode, JSON/schema output and tool isolation flags used here.

Automated tests use a fixture CLI contract. No Claude Code binary/account was available for a live
login or generation test. In particular, the exact `auth status` fields (`loggedIn`,
`authMethod: "claude.ai"`) and structured-output wrapper require live confirmation with your
installed version. Unsupported CLI flags or changed output fail closed; the helper does not fall
back to API billing. This is a reviewable prototype, not a claim of verified subscription backend
access.

Run helper regression tests with `node --test scripts/test/claude-code-helper.test.mjs`.
