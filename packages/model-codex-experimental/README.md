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
import { createCodexExperimentalModel } from '@mgravey/loom-model-codex-experimental';

const model = createCodexExperimentalModel({
  model: 'gpt-5.6-sol',
  wireProtocol: 'responses-lite',
  transport,
});
```

This package implements an unsupported compatibility experiment. It is not an official OpenAI
authentication method or API client, and its upstream protocol may change without notice.

Licensed under MPL-2.0.
