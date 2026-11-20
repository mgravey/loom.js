# `@mgravey/loom-model-anthropic-messages`

A credential-free adapter from the Loom.js coding-agent protocol to the
[Anthropic Messages API](https://platform.claude.com/docs/en/api/messages) with streaming
(server-sent events), tool use, and tool-result continuations.

```sh
pnpm add @mgravey/loom-model-anthropic-messages
```

`createAnthropicMessagesModel` never owns credentials. It builds one Messages request per model turn
and sends it through an injected `AnthropicMessagesTransport`. A trusted host can implement that
transport (for example a backend relay), or use the included direct transport for credentials the
user supplies.

```ts
import {
  createAnthropicDirectTransport,
  createAnthropicMessagesModel,
} from '@mgravey/loom-model-anthropic-messages';

const transport = createAnthropicDirectTransport({
  authentication: { type: 'api-key', getApiKey: () => userKeyFromMemory() },
  dangerouslyAllowBrowser: true, // only for the user's own key, in the user's browser
});
const [first] = await transport.listModels();
const model = createAnthropicMessagesModel({ model: first.id, transport });
```

## What the adapter maps

- Loom instructions to `system`; user, assistant, and tool messages to Messages turns. Tool results
  for one assistant turn are sent as `tool_result` blocks in a single user message; results shaped
  `{ ok: false, ... }` set `is_error`.
- Tool operations (for example `workspace/read-file`) to stable Claude tool names (for example
  `workspace_read-file`), and back.
- The SSE stream: `text_delta` becomes Loom `text` events; `tool_use` blocks with streamed
  `input_json_delta` become `tool-call` events after `content_block_stop`; `thinking`,
  `redacted_thinking`, signatures, and citations are preserved. Every assistant content block is
  emitted as an opaque continuation item and replayed verbatim on the next turn, as tool use with
  thinking requires. `ping` and unknown events or deltas are ignored.
- Stop reasons: `end_turn`, `stop_sequence`, and `tool_use` complete the turn; `pause_turn`
  continues it; `max_tokens` and `model_context_window_exceeded` raise `INCOMPLETE_RESPONSE` without
  running partial tool calls; `refusal` raises `REFUSED` with the refusal category.
- Options: `maxTokens` (default 32000), `thinking` (`{ type: 'adaptive', display? }` or
  `{ type: 'disabled' }`, omitted by default), `effort` (`output_config.effort`),
  `eagerInputStreaming`, and an `onUsage` observer for token counts. Sampling parameters are never
  sent (API version `2026-10-21` rejects them).

Provider continuation items from another adapter's context compaction are rejected rather than
silently dropped. The adapter does not implement `compact()`.

## Direct transport

`createAnthropicDirectTransport` supports the two ways a user pays for direct calls:

| Mode                                 | Headers                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `{ type: 'api-key', getApiKey }`     | `x-api-key` (or `Authorization: Bearer` with `header: 'authorization'`)              |
| `{ type: 'bearer', getAccessToken }` | `Authorization: Bearer`, no `x-api-key`; the host owns token acquisition and refresh |

Both send `anthropic-version` (default `2026-10-21`) and, with `dangerouslyAllowBrowser: true`,
`anthropic-dangerous-direct-browser-access: true`, which the API requires for cross-origin browser
requests. Hosts can add `betas` (joined into `anthropic-beta`), extra `headers`, and extra top-level
`bodyFields`. For a Claude Platform OAuth linked-billing connection, for example:

```ts
createAnthropicDirectTransport({
  authentication: { type: 'bearer', getAccessToken: () => session.accessToken() },
  betas: ['user-profiles-billing-2026-10-01'],
  headers: { 'anthropic-user-profile-id': profileId },
  bodyFields: { billing_policy: { type: 'billing_policy', bill_to: 'user_profile' } },
  dangerouslyAllowBrowser: true,
});
```

This package does not implement that OAuth flow, which needs a confidential server-side client;
Anthropic's linked-billing guide describes server-side calls and does not document browser use.
Credentials are requested per call, never cached, logged, or attached to errors. Managed headers
(`x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta`, ...) and adapter-owned body
fields cannot be overridden. `listModels()` pages through `GET /v1/models`; do not hard-code model
IDs as the source of truth.

## Errors

Failures are `AnthropicMessagesModelError` values with a stable `code`, `status`, allowlisted
`providerCode` (Claude API `error.type`, such as `overloaded_error` or `rate_limit_error`),
`retryable`, validated `retryAfterMs` and `requestId`, and `browserAccessDenied` when the
organization refuses browser (CORS) requests. Response bodies, provider messages, keys, and tokens
are never exposed.

Licensed under MPL-2.0.
