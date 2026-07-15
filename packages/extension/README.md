# `@loom/extension`

Provider-neutral Manifest V3 credential broker for Loom applications. This Phase 4 package ships
only a deterministic mock credential provider; it contains no OpenAI, Codex, or other provider
authentication logic.

The development manifest allows Chrome to route external messages from localhost. Chrome match
patterns do not narrow that permission by port, so this is intentionally only a coarse outer gate.
The message handler independently requires the exact origins `http://localhost:4173` or
`http://127.0.0.1:4173` before parsing or serving a request. Production packaging must replace both
the manifest matches and the handler allowlist with the application origins being deployed.

Refresh credentials are stored only in `chrome.storage.local`. The service worker sets the storage
access level to `TRUSTED_CONTEXTS` before its first credential access. Responses contain only a
short-lived access token and optional expiry; errors are structured and never include a refresh
credential or provider error detail.

Build the unpacked extension from the repository root:

```sh
pnpm --filter @loom/extension build
```

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`packages/extension/dist`. This package currently initializes only `loom/mock` with a
development-only mock refresh value. Real login, OAuth, Codex authentication, and production origin
configuration are deferred.

See the [credential-broker guide](../../docs/credential-broker.md) for the complete trust boundary
and local example workflow. The implementation follows Chrome's documentation for
[`externally_connectable`](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#external-webpage),
[Manifest V3 service workers](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3),
and [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage).
