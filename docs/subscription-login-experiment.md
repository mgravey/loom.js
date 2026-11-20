# Subscription login experiment

Branch: `feat/subscription-provider-login`. This work builds on the existing uncommitted
Companion/provider changes; it does not publish or commit them.

Companion 0.7.0 contains an opt-in Google account / Code Assist prototype. The standard manifest has
no Google OAuth client or identity permission, so the selector entry is disabled. The API-key
providers and Codex login remain available as before.

## Implemented

- Chrome-managed Google consent via `chrome.identity.getAuthToken`, initiated from settings only.
- A Loom-owned Chrome Extension OAuth client, supplied at packaging time.
- Tokens stay in Chrome's OAuth cache. Companion stores only a revocable session marker.
  Subscription profiles contain an optional project ID and configured model IDs, never tokens.
- Every catalogue request and generation rechecks account access with `loadCodeAssist`.
- Fixed Code Assist generation endpoint and verified request/response envelope mapping. No API-key
  fallback, arbitrary authenticated URL, automatic generation replay, paid-credit opt-in, or
  automatic onboarding.
- Native Gemini text/tool continuation, including opaque thought signatures.
- Sign-out clears local authorization and Chrome's extension token cache. Pending login and access
  checks cannot restore authorization after sign-out. In-flight generation may finish.
- A 120-second interactive sign-in timeout, 1.5-second silent token timeout and 8-second account
  probe deadline. Probes are limited to 64 KiB; generation retains its existing limits.
- Safe errors distinguish missing configuration/login, unsupported endpoint, account setup, access
  denial, rate limiting, provider failure, malformed data and timeout.
- Existing global website approval and saved-host permission checks run before token acquisition.

## What is and is not verified

Google's official Gemini CLI source supplies implementation evidence for OAuth, project/tier checks,
and the Code Assist generation wrapper. Chrome documents its separate extension OAuth flow. These
are different client identities: we have **not** verified that the Code Assist backend accepts a
Loom-owned Chrome Extension OAuth client.

The tests use a real extension with mocked Chrome OAuth and provider responses. They verify login,
fresh eligibility checks, model selection, tool-result continuation, credential isolation, logout,
denial and deadline behavior. They do not prove live subscription eligibility, available models,
quota accounting or billing.

The CLI uses an internal backend contract, not the public Gemini Developer API. No verified
model-list endpoint was found for that backend. Users therefore enter model IDs explicitly. Those
configured IDs appear in Loom after a fresh account-access check; generation determines whether each
model is available. They are not advertised as a live provider catalogue. The access check can
succeed for a free Code Assist account as well as a paid account; success is not proof of a paid
subscription.

Accounts needing onboarding must complete it in Google's official client. This prototype does not
follow provider-supplied URLs, accept terms, create projects, or poll onboarding operations. All
profiles currently use the Google account selected by Chrome for this extension; selecting multiple
simultaneous Google accounts is not implemented.

## Configure an experimental unpacked build

1. Build `@mgravey/loom-extension-codex-experimental` using the repository's usual build process.
2. Obtain the **public** extension key for your own extension registration, and its stable extension
   ID. Chrome's
   [OAuth setup guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
   describes obtaining the public key and keeping the ID consistent. Do not supply a private key.
3. In your Google Cloud project, configure OAuth consent and create a **Chrome Extension** OAuth
   client whose Item ID matches that extension. Add test users if the consent screen is in testing.
   The experiment requests `https://www.googleapis.com/auth/cloud-platform`; this is a broad Google
   Cloud scope, although Companion uses its token only for the fixed Code Assist endpoints.
4. Set these public build identifiers locally and run:

   ```sh
   export LOOM_GOOGLE_OAUTH_CLIENT_ID='YOUR_CLIENT.apps.googleusercontent.com'
   export LOOM_GOOGLE_EXTENSION_PUBLIC_KEY='YOUR_BASE64_PUBLIC_KEY'
   node scripts/prepare-google-subscription-experiment.mjs
   ```

   The script prints the derived extension ID. Confirm it matches the OAuth client's Item ID. It
   creates `store-artifacts/loom-google-subscription-experiment/` without changing the normal build
   or store archive. It adds only the identity permission and configured OAuth manifest. Do not use
   Google's CLI client ID or client secret.

5. Load that directory using **Load unpacked** at `chrome://extensions`.
6. In **Model servers**, choose **Google account / Code Assist**. Enter a connection ID, label and
   comma-separated model IDs available in your official client. Enter a Cloud project ID only if
   your account requires one. The backend address is fixed and the API-key field is disabled.
7. Save, grant Chrome host access, and complete Google's consent screen. A successful access probe
   permits saving. A rejected probe leaves the previous profile intact and reports the failure.
8. Approve the website in Companion, refresh models, and select your configured model. Use a new
   conversation for the first test.

If Google rejects this independent OAuth client, keep using the API-key integration. Do not change
the request to masquerade as Google's CLI or silently route to another billable service. Further
progress would require Google-supported client access or an integration with the official CLI.

## Anthropic

An additional Claude account option now uses a local helper and the unmodified official Claude Code
client. It does not collect Claude OAuth tokens. See
[Claude helper setup](claude-account-helper.md). Live account authentication has not been verified
in this environment.

## Authoritative evidence reviewed

Reviewed 2026-09-14; the links below track upstream main/docs and can change.

- [Gemini CLI OAuth implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts)
- [Code Assist tier/project setup](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/setup.ts)
- [Code Assist fixed backend and operations](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts)
- [Generation request and response envelopes](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/converter.ts)
- [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Chrome extension OAuth setup](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Claude authentication and third-party integration rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- [Claude Agent SDK subscription update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
