# Codex context compaction and recovery

## Verified backend contract (2026-09-13)

This implementation follows OpenAI's official `openai/codex` source at commit
[`70eb36203dbb8c75d006b39cdfae74bd04e18a65`](https://github.com/openai/codex/tree/70eb36203dbb8c75d006b39cdfae74bd04e18a65),
retrieved during this investigation. This is implementation evidence, not a promise of account or
model availability on the deployed ChatGPT service.

- [Provider routing](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/model-provider-info/src/lib.rs)
  defines the ChatGPT Codex base as `https://chatgpt.com/backend-api/codex`.
  [Responses HTTP routing](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/codex-api/src/endpoint/responses.rs)
  uses `/responses`.
- [Remote compaction v2 request construction](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/core/src/compact_remote_v2_attempt.rs)
  appends `{ "type": "compaction_trigger" }` to the complete input and uses the ordinary model
  stream. It does not call `/responses/compact`.
- [The shared client](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/core/src/client.rs)
  builds the normal streaming Responses request, including model, reasoning, tools and instructions.
  Responses Lite prepends `additional_tools` and the developer instructions to input, disables
  parallel tool calls, sets reasoning context to `all_turns`, and attaches
  `x-openai-internal-codex-responses-lite: true`. Compaction uses that same path.
- [Bearer authentication](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/model-provider/src/bearer_auth_provider.rs)
  attaches `Authorization: Bearer …` and `ChatGPT-Account-ID` for account-routed bearer requests.
  [Session headers](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/codex-api/src/requests/headers.rs)
  attach `session-id` and `thread-id`; the Responses endpoint sets `Accept: text/event-stream`.
- [The compaction collector](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/core/src/compact_remote_v2.rs)
  requires `response.completed` and exactly one compaction item from `response.output_item.done`.
  Other streamed output does not represent actions to execute.
  [The item schema](https://github.com/openai/codex/blob/70eb36203dbb8c75d006b39cdfae74bd04e18a65/codex-rs/protocol/src/models.rs)
  requires string `encrypted_content` and accepts `compaction_summary` as a compaction alias.

The public
[Responses compact API](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
is a different contract. Its non-streaming JSON `output` envelope is not evidence for the ChatGPT
Codex backend. Loom previously mixed that envelope with a hardcoded ChatGPT `/responses/compact`
URL. That path returned 404 in the Studio incident. The source establishes the current v2 path; it
does **not** establish why that account's old route returned 404, when it was removed, or whether
`gpt-5.6-sol` v2 compaction is enabled for every account. No authenticated live backend test was
run.

## Wire and checkpoint behavior

The extension now uses only `POST https://chatgpt.com/backend-api/codex/responses` for both
operations. It keeps Bearer authentication and `ChatGPT-Account-ID` routing inside the extension,
uses JSON request content and `Accept: text/event-stream`, and retains the existing originator,
session/thread, client request ID, version and Lite headers. No new credentials, arbitrary URL
override, origin approval bypass or endpoint allowlist entry is introduced. `operation: 'compact'`
remains explicit on the credential-free Companion protocol. The exported compact endpoint constant
is an alias for the fixed Responses endpoint.

The model bounds compact response text to 4 MiB and checkpoints to 2,000 items. It validates the
entire stream, completion and encrypted summary before returning immutable items. The checkpoint
retains user and client developer messages, followed by the opaque summary. Lite's freshly generated
instructions/tools prefix and the trigger are not persisted. Unlike the upstream client's retention
budget policy, Loom does not truncate retained messages or images. Tool calls, paired results and
opaque reasoning are sent unchanged through the normal request encoder; the validated provider
summary represents them in the replacement checkpoint. Compaction output never executes tools.

A failed, cancelled, timed-out, empty, oversized or malformed compaction never installs a checkpoint
or rewrites the transcript. Only a fully validated replacement is committed. Keep persisting
`session.contextCheckpoint` (`items`, `coveredTranscriptEntries`) atomically with its matching
transcript; do not persist anything from a failed compaction as a new checkpoint.

## Bounded recovery

Each model instance has a five-minute unsupported-compaction cache, scoped by the operation
context's session ID (or a default scope when omitted). The model/transport instance fixes the
endpoint and model. HTTP 404, 405 and 501 mark compaction unavailable; they are not retried. The
cache holds at most 128 session entries. `model.resetCompactionAvailability()` explicitly clears it.
Create a new model/transport when changing the account, endpoint, or Companion session identity; do
not reuse a model across changing credential-routing functions without resetting its cache.

Compaction retries eligible pre-stream HTTP 408/429/5xx rejections and classified provider fetch
failures up to **three total attempts**, with exponential backoff, jitter and Retry-After as a lower
bound. Nonretryable auth/quota/policy codes take precedence. The default **60-second overall
compaction deadline**, including transport wait, stream consumption and backoff, is configurable
with `compactionTimeoutMs` (1 through 300,000 ms). Cancellation/deadline closes the child transport
and clears retry timers. An accepted stream that fails is surfaced without replay; generation is
never automatically retried by the model adapter. A context overflow can trigger one agent-level
compaction/retry only before text, tool calls or continuation items have been delivered. Previously
completed tools remain in history and are not executed again by this recovery.

Authentication failures, rate limits, transient HTTP errors, invalid responses and actual extension
disconnections retain distinct codes/status/remote metadata. Model wrappers retain only a
structural, allowlisted cause snapshot, never the raw transport error. Diagnostics include
operation, request ID, stage, HTTP status where available, safe provider/remote code and
retryability. Provider display messages are not copied into diagnostic logs: even redacted provider
prose can echo user input. Credential, prompt, body and encrypted-reasoning logging is prohibited.

## Studio integration and upgrades

Release the accompanying Changeset for `loom-model-codex-experimental`,
`loom-companion-codex-experimental`, `loom-agent-codex` and `loom-coding`. Rebuild/reload or deploy
the Companion extension **0.3.0** from the same revision, then update Studio's dependencies and
reload its page. The old extension expects the obsolete compact envelope, so a website-only package
upgrade is insufficient. This change does not require changing `gpt-5.6-sol` or the `responses-lite`
selection. Direct-fetch integrations must use the same audited generation/compaction endpoint; a
distinct `compactEndpoint` is rejected. Public API integrations should use the public Responses
adapter.

```ts
const model = createCodexExperimentalModel({
  model: 'gpt-5.6-sol',
  wireProtocol: 'responses-lite',
  transport: companion.transport,
  compactionTimeoutMs: 60_000,
});
const session = createCodingSession({
  model,
  tools,
  transcript,
  contextCheckpoint: savedCheckpoint,
  contextCompaction: {
    maximumCharacters: 500_000,
    // Optional: set only from a host-verified context budget with output/token reserves.
    // fallbackMaximumCharacters: verifiedSafeCharacterBudget,
  },
});
```

`maximumCharacters` is a proactive threshold, **not** evidence that the full transcript fits the
model. Without an explicit `fallbackMaximumCharacters`, failed proactive compaction stops with a
recoverable `COMPACTION_UNAVAILABLE` / context-limit error. With that budget, eligible failures may
continue using the original transcript/checkpoint. Every subsequent generation while falling back is
checked with the model's exact serialized `requestCharacters()` measurement, including tools and
instructions, against that budget and the relay's 4 MiB limit (with metadata headroom). There is no
inferred character-to-token conversion. Models without a size measurement cannot use this fallback.
Authentication and disconnection failures are surfaced, not treated as compaction support failures.
A provider-reported context overflow always requires successful compaction to proceed.

Studio should keep its last valid persisted state on all failures, display actionable
auth/connection errors separately, and offer an explicit retry after restoring support or resetting
availability. Do not restart the whole agent task automatically after failure: an interrupted
generation may have already delivered text, and completed external tool actions are not undone.
Loom's in-run recovery avoids duplicate actions; resuming a failed task across runs still requires
the host to retain its execution state. This repository does not contain the affected Studio
deployment, so deployment and an account-authenticated smoke test remain integration work for that
host.

Private investigation captures belong in ignored `context-compaction-dumps/`; do not commit them.
