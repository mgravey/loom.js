# Phase 5.5 experimental vertical slice

Phase 5.5 is the first runnable composition that joins a browser-hosted Loom runtime, workspace
tools, the Codex-style agent, an experimental model adapter, and the separate credential extension.
It is a private interoperability experiment. It is not a supported OpenAI integration and must not
be deployed as a production authentication or inference path.

## Trust boundary

```text
Loom workbench page
  |-- origin approval/status/logout/direct-auth --------> extension
  |                                                       |-- refresh credential storage
  |                                                       `-- account routing metadata
  |<-- short-lived access token + routing ID ------------'
  `-- authenticated provider fetch ---------------------> chatgpt.com
       `-- pre-response failure --> extension relay -----> chatgpt.com
```

The page never receives the refresh or ID token. Initial authorization parses the ID token only
inside the extension and retains the refresh credential and ChatGPT account routing ID in trusted
storage. The page must first match the manifest and receive a one-time exact-origin user grant. For
each direct model session, the approved workbench origin receives a short-lived access token plus
routing ID and performs the provider fetch itself. This deliberately tests whether the audited
backend now accepts the localhost CORS preflight. If the page receives no HTTP response, it retries
the credential-free body through the extension; HTTP errors and cancellation are not retried.

The provider-specific direct-auth message remains separate from the provider-neutral credential
broker protocol so this weaker experimental boundary does not change generic authentication.

## Build and install

Requirements are Node.js 22, pnpm 11.7.0, and Chrome or Chromium 116 or newer.

```sh
pnpm install --frozen-lockfile
pnpm build
python3 -m http.server 4173 --directory packages
```

Keep the server running. In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `packages/extension-codex-experimental/dist` from this repository.
5. Copy the generated extension ID.
6. Open the extension's **Details**, then **Extension options**.
7. Read the warning and enable the experimental authentication flows.
8. Optional, on a private computer only: select **Remember sign-in on this Chrome profile** and
   confirm the warning. Otherwise authorization ends when Chrome closes.
9. Select **Sign in with ChatGPT** for the browser/PKCE callback bridge, or choose **Use device-code
   fallback**, open the displayed provider URL, enter the displayed code, and finish sign-in.
10. Confirm that the options page reports either browser-session or remembered-profile storage.

Do not paste any token response into Loom. The extension completes the exchange itself. If a
provider endpoint rejects the request, treat that as an unsupported experiment result; do not copy
credentials from Codex CLI or another application.

## Run the browser application

Open the welcome page at <http://localhost:4173/example-codex-experimental/> in the same Chrome
profile, then choose **Open workbench**. The runnable application is
<http://localhost:4173/example-codex-experimental/workbench.html>.

1. Paste only the non-secret extension ID into **Experimental extension ID**.
2. The page checks the configured extension automatically. If needed, select **Reconnect**. On first
   contact, Chrome opens trusted extension options.
3. Approve the displayed exact workbench origin and return to the workbench. Reloading checks the
   extension automatically.
4. Keep the suggested model or enter a model currently available to the signed-in account. Model
   availability is provider-controlled and may change independently of Loom.
5. Select a direct directory, disposable memory project, or persistent OPFS project. Folder and ZIP
   import are available for virtual projects, and every mode can export a ZIP.
6. Enter an agent request, select the arrow send button, and inspect the conversation. Workspace
   tools appear as compact collapsible activity; the closed utility drawer contains the editor and
   manual QuickJS, WebContainer Node.js, or Pyodide Python runner.
7. Select **Log out** when finished. Logout removes both the refresh credential and saved
   account-routing ID from session and persistent extension storage.

The manifest permits only `http://localhost:4173` and `http://127.0.0.1:4173` in development, and
each exact origin still requires a separate user grant. Serving the page from another origin or port
is expected to fail. Grants persist until revoked; disabling the experiment clears them.

## Diagnose a failed run

The provider request is owned by the workbench page and appears in its **Network** panel. Before
retrying:

1. On the localhost application, open **Developer tools → Console** and filter for
   `[loom:page-extension]`.
2. Open **Network**, filter for `chatgpt.com`, and preserve the log.
3. Submit the coding request. Inspect the direct attempt. If it fails before an HTTP response,
   confirm `model.fetch.fallback` and the extension relay diagnostics. Later turns in the same page
   session should use the relay without another direct attempt.

The page logs status, direct-auth envelope metadata, provider status, and sanitized provider error
fields. The workbench defaults to `gpt-5.6-sol` and uses Responses Lite for GPT-5.6 model IDs. Lite
moves instructions and tools into developer input items, uses `reasoning.context: "all_turns"`,
disables parallel tool calls, and injects the required transport header. Older model IDs retain the
classic Responses shape.

`ACCOUNT_ROUTING_UNAVAILABLE` with an otherwise authenticated status indicates partial state from an
older or interrupted authorization. Select **Log out** in the workbench (or **Remove stored
authorization** in extension options), then complete a fresh device authorization. A refresh token
cannot reconstruct the missing account-routing claim, so reauthorization is required.

An HTTP rejection logs its numeric status plus bounded `error.code`, `error.type`, and `error.param`
values. A pre-response fetch failure tells the operator to inspect the browser CORS error. Console
diagnostics never include tokens, account IDs, authorization headers, prompts, tool arguments, file
contents, or response chunks; the Network panel necessarily shows the direct request and must be
treated as sensitive.

## Safe automated verification

The automated scenario uses an unpacked extension, synthetic credentials, local intercepted auth
responses, local SSE model responses, and an OPFS directory handle. It never contacts OpenAI:

```sh
pnpm build
pnpm exec playwright test tests/browser/example-codex-experimental.spec.ts
```

The scenario proves:

- opt-in authorization from trusted extension UI;
- extension-owned refresh and account-routing state, including the session-default persistence
  contract;
- first-contact exact-origin approval and a durable grant;
- page-visible authentication status and origin-authorized direct credentials;
- a failed page-originated attempt, extension-relayed turn, and later direct turn;
- a real `workspace/list-files` tool execution;
- a second model turn containing tool output;
- streamed completion and deterministic cleanup;
- page-initiated logout deleting extension-owned state.

Run `pnpm check` for the complete repository gate.

## Live experiment limitations

On 2026-07-16, a user-reported manual device-code attempt observed successful token issuance. That
is evidence of compatibility at one moment, not a supported contract. The current open-source Codex
inference protocol was re-audited at commit
[`9ff47868eb2afeec579183e01bb9d3d3e9df2bcd`](https://github.com/openai/codex/tree/9ff47868eb2afeec579183e01bb9d3d3e9df2bcd).
It uses `POST https://chatgpt.com/backend-api/codex/responses`, bearer authentication, and the
`ChatGPT-Account-ID` routing header. These are implementation details, not the documented OpenAI
Platform Responses API.

Use a dedicated test account, do not share token payloads, and log out immediately after testing.
The normal browser path keeps the CLI's registered localhost redirect and uses a tab-scoped DNR rule
to transform that navigation into an extension callback page before localhost is contacted. This is
an observed compatibility mechanism, not a supported third-party OAuth registration.
