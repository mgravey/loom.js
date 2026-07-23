# Provider failure handling

The experimental Codex model path preserves enough rejection context for a host to display a safe
reason and resume from its existing checkpoint. It does not forward the provider response envelope.

`CodexExperimentalModelError` exposes these optional fields:

| Field              | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `status`           | Valid HTTP or event status, when supplied                            |
| `providerCode`     | Bounded provider identifier                                          |
| `providerMessage`  | Display-safe message capped at 512 characters                        |
| `incompleteReason` | Bounded reason from `response.incomplete`                            |
| `retryable`        | Loom's transient-failure classification                              |
| `retryAfterMs`     | Validated provider delay derived from `Retry-After`, capped at 24 hr |

## Streamed events

The parser reads both nested and top-level provider shapes:

- `error`: `code` and `message`, either directly or from an `error` object;
- `response.failed`: `response.error`, `error`, or top-level `code` and `message`; and
- `response.incomplete`: nested or top-level `incomplete_details.reason`.

HTTP 408, HTTP 429, HTTP 5xx, `rate_limit_exceeded`, `server_error`, and `service_unavailable` are
transient by default. Codes indicating insufficient quota, billing or credit rejection,
authentication, invalid requests, permissions, policy, or account restrictions override status-based
retryability and remain non-retryable.

## Companion boundary

For a non-2xx response, the extension reads at most 16 KiB solely to select an allowlisted code and
message. It removes control characters, redacts common bearer tokens, API keys, cookies, and
credential-like assignments, and then emits:

```ts
{
  type: 'provider-error',
  requestId,
  status,
  providerCode,
  providerMessage,
  retryable,
  retryAfterMs,
}
```

The website Companion validates the status, identifier syntax, message length, boolean, and bounded
integer delay, then sanitizes the message again. Unknown fields are ignored. The complete response
body, response headers, credentials, and arbitrary provider error objects never enter the public
transport response.
