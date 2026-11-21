# `@mgravey/loom-auth-chatgpt-browser`

Browser-only **Sign in with ChatGPT** for Loom.js. It implements OpenAI's documented open-source
flow (dynamic client registration, PKCE S256, no client secret, loopback callback) entirely in the
page and exposes a credential-free `OpenAICompatibleResponsesTransport` for
`@mgravey/loom-model-openai-responses`. No extension, API key, token backend, or model relay is
involved.

```sh
pnpm add @mgravey/loom-auth-chatgpt-browser @mgravey/loom-model-openai-responses
```

> **Origin requirement.** OpenAI's open-source registration accepts only an HTTP loopback redirect
> on `127.0.0.1` (not `localhost`, not HTTPS, not a public website). `getStatus().supported` is true
> only on `http://127.0.0.1:<port>`; elsewhere `unsupportedReason` says why so the host can explain
> it and fall back to another connection.

## Use

```ts
import {
  createChatGPTBrowserClient,
  CHATGPT_MANAGE_USAGE_URL,
} from '@mgravey/loom-auth-chatgpt-browser';
import { createOpenAICompatibleResponsesModel } from '@mgravey/loom-model-openai-responses';

const chatgpt = createChatGPTBrowserClient({ appName: 'My App' });
chatgpt.subscribe((status) => render(status));

button.onclick = () => void chatgpt.signIn(); // call synchronously from the click
const [first] = await chatgpt.listModels();
const model = createOpenAICompatibleResponsesModel({
  model: first.slug,
  transport: chatgpt.transport,
});
```

Serve the callback path (default `/auth/callback`) from the same origin. In a single-page app the
route only needs:

```ts
import { completeChatGPTBrowserCallback } from '@mgravey/loom-auth-chatgpt-browser';

const result = completeChatGPTBrowserCallback(); // { delivered: true } or { delivered: false, reason }
```

It strips the one-time code from history, checks the loopback origin, path, and same-origin opener,
and posts the URL only to the opener's exact origin. The opener validates `state`, exchanges the
code, verifies the ID token, and closes the popup. Pass the same `callbackPath` and `messageType` to
both functions when overriding them.

## Options

| Option                                | Default                         | Purpose                                                                   |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `appName` (required)                  | —                               | `agent_name_hint` on first registration                                   |
| `callbackPath`                        | `/auth/callback`                | Loopback callback route                                                   |
| `messageType`                         | `loom/chatgpt-browser/callback` | `postMessage` type shared with the callback helper                        |
| `storage`                             | `window.localStorage`           | Non-secret registration/host metadata; `null` = memory only               |
| `storageKeyPrefix`                    | `loom.chatgpt-browser.`         | Metadata key prefix                                                       |
| `notices`                             | generic English text            | `ready`, `planNotGranted`, `revocationUnconfirmed`, `unsupported(reason)` |
| `toolNamespace`                       | `loom`, generic description     | Namespace wrapping function tools                                         |
| `fetch`, `now`                        | global `fetch`, `Date.now`      | Injection for tests and embedded hosts                                    |
| `signInTimeoutMs`, `requestTimeoutMs` | 5 min, 10 min                   | Attempt and per-request lifetimes                                         |
| `sessionStore`                        | none (memory only)              | Opt-in host store for resuming a session after reload                     |

## Remembering a session (opt-in)

By default a reload signs the user out. A host that wants to resume sessions passes a `sessionStore`
with async `load()`, `save(session)` and `clear()`:

```ts
const client = createChatGPTBrowserClient({
  appName: 'My App',
  sessionStore: {
    load: () => myVault.read(), // previously saved value, or null
    save: (session) => myVault.write(session),
    clear: () => myVault.remove(),
  },
});

await client.restoreSession(); // 'restored' | 'none' | 'discarded' | 'unavailable' | 'superseded'
```

- `session` is an opaque, versioned, JSON-serialisable `ChatGPTBrowserPersistedSession`. It holds
  the **refresh token**, the issued client ID, the verified subject/email, the sign-in nonce and the
  granted scopes. Treat it as a secret. Access and ID tokens are never included.
- **The host decides where it lives and is responsible for protecting it.** Browser storage
  (`localStorage`, `sessionStorage`, IndexedDB, script-readable cookies) is discouraged: any script
  on the origin could read it. Prefer a server-side or user-owned secret store reached over an
  authenticated channel.
- `restoreSession()` never opens a popup and never trusts the stored value: it refreshes the token
  and requires a freshly signed ID token for the stored subject and client ID, exactly like a normal
  refresh. Malformed values, terminal refresh errors, `invalid_client`, and identity mismatches call
  `clear()`; store or network failures keep the value (`unavailable`). If the refresh succeeded but
  verification was only delayed, the rotated refresh token is saved for the next attempt.
- `save()` runs after sign-in, after every refresh-token rotation, after a restore, and on
  `saveSession()`. `clear()` runs on `signOut()`, when a refresh confirms the session is unusable,
  and on `forgetStoredSession()`. `dispose()` does not clear.
- Store calls run one at a time in order, so a sign-out issued during a save clears after it, and a
  restore overtaken by sign-in, sign-out or disposal returns `superseded` without applying anything.
  Each method must settle; apply your own timeouts. Store failures never fail sign-in and never
  appear in errors.
- Refresh tokens rotate. Two pages restoring or refreshing the same stored session concurrently can
  trigger `refresh_token_reused`, which ends the session; restore in one page at a time.

## Security properties

- Access, refresh, and ID tokens and login transactions (state, nonce, PKCE verifier) stay in memory
  and are never written to Web Storage. Only an explicitly configured `sessionStore` receives the
  refresh token. Storage holds only issued client IDs, labels, the verified subject/email, and the
  opaque `ext_agent_host_id`.
- The callback must match the attempt's `state`, origin, path, popup source, and message type and is
  consumed once. The ID token's signature (published JWKS), issuer, audience, expiry, and nonce are
  verified; `chatgpt.tokens.use.direct` must be granted before any model request.
- Reauthorization reuses the issued client ID with `id_token_hint` (in-memory only) or `login_hint`,
  never `agent_name_hint`, and rejects a different verified identity.
- Refresh is single-flight. Documented terminal refresh codes clear the session
  (`reauthentication-required`); network, 429, and 5xx failures keep it. `signOut()` stops requests,
  attempts revocation, clears tokens, and keeps registrations; `revoked: false` means the user
  should disconnect the app in ChatGPT Settings.
- Requests force `store: false`, `stream: true`, and the public `https://api.openai.com/v1`
  endpoint, drop undocumented fields, and require `response.completed`.
- Errors are `ChatGPTBrowserError` instances with a stable `kind`. Provider bodies, codes outside
  the documented allowlist, URLs, and tokens are never exposed.

| `kind`                                                         | Recovery                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `usage-limit-reached`                                          | "Usage limit reached" with **Manage usage** → `CHATGPT_MANAGE_USAGE_URL` |
| `user-not-eligible`                                            | Explain; do not retry or loop through sign-in                            |
| `temporarily-unavailable`                                      | Keep the session; retry later with bounded backoff (`retryable`)         |
| `unsupported-capability`                                       | Remove the unsupported input, tool, feature, or model                    |
| `reauthentication-required`                                    | Sign out and sign back in with ChatGPT                                   |
| `plan-not-granted`                                             | Signed in without plan usage; models stay disabled                       |
| `credential-rejected`, `access-denied`, `client-configuration` | Show the restriction; do not retry unchanged                             |

## Known limits

As of 2026-11-20, `https://auth.openai.com/.well-known/openid-configuration` and its JWKS return no
`Access-Control-Allow-Origin` header, so browser ID-token verification fails with a
`temporarily-unavailable` error even when authorization succeeds. Signature verification is
mandatory; this package does not proxy or skip it. See the
[authentication notes](../../docs/codex-auth-experiment.md#extension-free-sign-in-with-chatgpt).

Licensed under MPL-2.0.
