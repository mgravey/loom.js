# Phase 5.5 experimental vertical slice

Phase 5.5 is the first runnable composition that joins a browser-hosted Loom runtime, workspace
tools, the Codex-style agent, an experimental model adapter, and the separate credential extension.
It is a private interoperability experiment. It is not a supported OpenAI integration and must not
be deployed as a production authentication or inference path.

## Trust boundary

```text
localhost Loom page
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
7. Read the warning and enable the experimental device-code flow.
8. Select **Start device authorization**, open the displayed provider URL, enter the displayed code,
   and finish sign-in.
9. Confirm that the options page says a refresh credential is stored.

Do not paste any token response into Loom. The extension completes the exchange itself. If a
provider endpoint rejects the request, treat that as an unsupported experiment result; do not copy
credentials from Codex CLI or another application.

## Run the browser application

Open <http://localhost:4173/example-codex-experimental/> in the same Chrome profile.

1. Paste only the non-secret extension ID into **Experimental extension ID**.
2. Select **Check authentication**.
3. Keep the suggested model or enter a model currently available to the signed-in account. Model
   availability is provider-controlled and may change independently of Loom.
4. Enter an agent request.
5. Select **Choose directory and run**, approve a workspace directory, and inspect the streamed
   event log.
6. Select **Log out extension credential** when finished. Logout removes both the refresh credential
   and saved account-routing ID.

The extension authorizes only `http://localhost:4173` and `http://127.0.0.1:4173` in development.
Serving the page from another origin or port is expected to fail.

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
The direct `chrome.identity` authorization path remains blocked because the CLI's registered
localhost redirect does not establish support for Chrome's `chromiumapp.org` redirect.
