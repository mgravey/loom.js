# `@mgravey/loom-companion-codex-experimental`

Experimental website client for the published **Loom.js Companion** Chrome extension. It requests
explicit approval for the calling website origin, exposes the extension-backed Loom authentication
provider, and routes credential-free Codex model request bodies through an external Chrome port.
Access tokens, account routing, provider headers, and the upstream request remain extension-owned.

```sh
pnpm add @mgravey/loom-core \
  @mgravey/loom-agent-codex \
  @mgravey/loom-coding \
  @mgravey/loom-model-codex-experimental \
  @mgravey/loom-companion-codex-experimental
```

```ts
import { createCodexCompanion } from '@mgravey/loom-companion-codex-experimental';
import { createCodexExperimentalModel } from '@mgravey/loom-model-codex-experimental';

const companion = createCodexCompanion({
  runtime: chrome.runtime,
  sessionId: 'website-session',
});

await companion.ensureOriginAccess();

const model = createCodexExperimentalModel({
  model: 'gpt-5.6-sol',
  wireProtocol: 'responses-lite',
  transport: companion.transport,
});
```

For rejected upstream responses, the extension sends only a validated status and bounded
`providerCode`, `providerMessage`, `retryable`, and `retryAfterMs` values. The Companion validates
and re-sanitizes every field before exposing it to the model adapter. It never exposes the complete
provider body, response headers, credentials, or arbitrary error objects.

The same credential-free transport accepts `operation: 'compact'`. The extension validates the
separate compaction envelope and routes it only to `/backend-api/codex/responses/compact`; it never
accepts a caller-provided endpoint.

The default extension ID is `gdcebopdllcifgleoefgbobdopiaholg`. Production callers must use HTTPS,
and the extension user must approve the exact website origin. Local development is limited to
localhost and `127.0.0.1`. The extension protocol and Codex-compatible provider integration remain
unsupported experiments; do not describe them as an official OpenAI authentication or API.

Licensed under MPL-2.0.
