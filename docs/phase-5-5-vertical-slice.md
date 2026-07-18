# Phase 5.5 experimental vertical slice

Phase 5.5 is the first runnable composition that joins a browser-hosted Loom runtime, workspace
tools, the Codex-style agent, an experimental model adapter, and the separate credential extension.
It is a private interoperability experiment. It is not a supported OpenAI integration and must not
be deployed as a production authentication or inference path.

## Trust boundary

```text
Loom workbench page
  |-- status/logout messages ---------------------------> extension
  |-- credential-free model request over runtime.Port --> extension
  |                                                       |-- refresh credential storage
  |                                                       |-- account routing metadata
  |                                                       `-- authenticated provider fetch
  `-- streamed response bytes <-------------------------- extension
```

The page never receives the access token, refresh token, or ID token. Initial authorization parses
the ID token only inside the extension and retains only the non-bearer ChatGPT account routing ID in
trusted storage. The extension performs the provider request because the audited ChatGPT backend
does not accept a localhost page's CORS preflight with the required authorization and account
headers.

The model transport is intentionally separate from the provider-neutral credential-broker protocol.
Expanding the broker's `getAccessToken` contract into a provider inference protocol would couple
generic authentication to Codex.

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
8. Select **Sign in with ChatGPT** for the browser/PKCE callback bridge, or choose **Use device-code
   fallback**, open the displayed provider URL, enter the displayed code, and finish sign-in.
9. Confirm that the options page says a refresh credential is stored.

Do not paste any token response into Loom. The extension completes the exchange itself. If a
provider endpoint rejects the request, treat that as an unsupported experiment result; do not copy
credentials from Codex CLI or another application.

## Run the browser application

Open the welcome page at <http://localhost:4173/example-codex-experimental/> in the same Chrome
profile, then choose **Open workbench**. The runnable application is
<http://localhost:4173/example-codex-experimental/workbench.html>.

1. Paste only the non-secret extension ID into **Experimental extension ID**.
2. Select **Check authentication**.
3. Keep the suggested model or enter a model currently available to the signed-in account. Model
   availability is provider-controlled and may change independently of Loom.
4. Select a direct directory, disposable memory project, or persistent OPFS project. Folder and ZIP
   import are available for virtual projects, and every mode can export a ZIP.
5. Enter an agent request, select **Run agent**, and inspect the streamed event log. The lower
   runner can execute QuickJS, WebContainer Node.js, or Pyodide Python against the same project
   snapshot.
6. Select **Log out extension credential** when finished. Logout removes both the refresh credential
   and saved account-routing ID.

The extension authorizes only `http://localhost:4173` and `http://127.0.0.1:4173` in development.
Serving the page from another origin or port is expected to fail.

## Diagnose a failed run

The provider request is owned by the extension service worker. It therefore does not appear in the
localhost page's **Network** panel. Open both diagnostic consoles before retrying:

1. On the localhost application, open **Developer tools → Console** and filter for
   `[loom:page-extension]`.
2. Open `chrome://extensions`, select the Loom Codex experiment, then select the **service worker**
   inspection link. Filter that console for `[loom:extension-model]`.
3. Retry **Choose directory and run**. Keep the service-worker inspector open so Chrome does not
   suspend it between diagnostic events.

The page logs credential-status messages plus Port request/start/chunk/end/error metadata. The
extension logs origin authorization, envelope validation, account-routing lookup, token refresh,
provider-fetch host/path/method/model, HTTP status, and stream totals. The workbench defaults to
`gpt-5.6-sol` and uses Responses Lite for GPT-5.6 model IDs. Lite moves instructions and tools into
developer input items and the extension injects the required transport header; older model IDs
retain the classic Responses shape. A failure returned to the page includes one safe code and stage:

| Code                          | Meaning before provider inference                                      |
| ----------------------------- | ---------------------------------------------------------------------- |
| `UNAUTHORIZED_ORIGIN`         | The page origin is not in the exact extension allowlist                |
| `INVALID_REQUEST`             | The external Port envelope or provider request shape failed validation |
| `ACCOUNT_ROUTING_UNAVAILABLE` | The sign-in did not leave usable ChatGPT account-routing metadata      |
| `AUTHENTICATION_FAILED`       | The extension could not obtain/refresh a short-lived access token      |
| `PROVIDER_FETCH_FAILED`       | The provider fetch failed before an HTTP response was received         |
| `PROVIDER_STREAM_FAILED`      | A successful provider response could not be streamed                   |
| `CANCELLED`                   | The page disconnected or cancelled the run                             |

`ACCOUNT_ROUTING_UNAVAILABLE` with an otherwise authenticated status indicates partial state from an
older or interrupted authorization. Select **Log out extension credential**, then complete a fresh
device authorization from the extension options page. A refresh token cannot reconstruct the missing
account-routing claim, so reauthorization is required.

An HTTP rejection such as an unavailable model, account entitlement, rate limit, or depleted credit
is logged separately as `model.response.start` with its numeric status. The extension reads at most
16 KiB from a rejected response and exposes only syntactically restricted `error.code`,
`error.type`, and `error.param` values. Raw provider messages and bodies are discarded. Diagnostics
otherwise include only request IDs, stages, status codes, target host/path, method/model,
character/chunk counts, and sanitized broker codes. They never include tokens, account IDs,
authorization headers, prompts, tool arguments, file contents, or response chunks.

## Safe automated verification

The automated scenario uses an unpacked extension, synthetic credentials, local intercepted auth
responses, local SSE model responses, and an OPFS directory handle. It never contacts OpenAI:

```sh
pnpm build
pnpm exec playwright test tests/browser/example-codex-experimental.spec.ts
```

The scenario proves:

- opt-in authorization from trusted extension UI;
- extension-owned refresh and account-routing state;
- page-visible authentication status without a token;
- a model turn through the external Port;
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
