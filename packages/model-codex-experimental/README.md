# `@mgravey/loom-model-codex-experimental`

Experimental credential-free Codex request generation and streamed response parsing for Loom.js. The
package maps Loom model/tool turns to the audited request envelope and parses streamed text, tool
calls, and completion events. It does not own credentials, an upstream endpoint, or a network
transport.

```sh
pnpm add @mgravey/loom-model-codex-experimental
```

Route requests through the published Loom.js Companion extension with
`@mgravey/loom-companion-codex-experimental`, or inject another explicitly audited transport.

```ts
import {
  CodexExperimentalModelError,
  createCodexExperimentalModel,
} from '@mgravey/loom-model-codex-experimental';

const model = createCodexExperimentalModel({
  model: 'gpt-5.6-sol',
  wireProtocol: 'responses-lite',
  transport,
});
```

The returned model also exposes provider-native compaction:

```ts
const checkpoint = await model.compact(modelRequest);
// Persist checkpoint.items as opaque JSON and replay them through request.contextItems.
```

Brokered compact calls use an explicit `operation: 'compact'`; direct mode defaults to
`${endpoint}/compact` or accepts an audited `compactEndpoint`. Successful output is limited to 4 MiB
and 2,000 JSON-object items before it can become model context.

Provider rejections throw `CodexExperimentalModelError` with safe structured fields:

```ts
try {
  for await (const event of model.generate(request)) {
    // Consume events.
  }
} catch (error) {
  if (error instanceof CodexExperimentalModelError && error.code === 'PROVIDER_ERROR') {
    console.log(error.providerCode, error.providerMessage);
    if (error.retryable) scheduleRetry(error.retryAfterMs);
  }
}
```

The parser supports top-level and nested `error`, `response.failed`, and `response.incomplete`
shapes. Messages are limited to 512 characters, stripped of control characters, and redacted for
common bearer-token, API-key, cookie, and credential patterns. Authentication, billing, invalid
request, policy, and account restrictions are never classified as automatically retryable.
Context-window codes remain non-retryable without mutation but set
`contextCompactionRequired: true`, allowing a compatible agent to compact and retry the failed turn.

This package implements an unsupported compatibility experiment. It is not an official OpenAI
authentication method or API client, and its upstream protocol may change without notice.

Licensed under MPL-2.0.
