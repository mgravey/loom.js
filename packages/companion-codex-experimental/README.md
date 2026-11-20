# `@mgravey/loom-companion-codex-experimental`

The current npm release is `0.2.1`.

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
streaming compaction trigger and routes it only to `/backend-api/codex/responses`; it never accepts
a caller-provided endpoint.

Successful responses use a request-scoped terminal handshake. The Companion validates `end`, marks
the request complete, finishes the response stream, and returns `end-ack`; the extension closes the
Port only after that acknowledgement. A disconnect before `end` remains `CONNECTION_FAILED`, while a
later cleanup disconnect cannot overwrite an already completed result. The additive handshake
remains protocol-version-1 compatible with older extension and Companion releases.

The default extension ID is `gdcebopdllcifgleoefgbobdopiaholg`. Production callers must use HTTPS,
and the extension user must approve the exact website origin. Local development is limited to
localhost and `127.0.0.1`. The extension protocol and Codex-compatible provider integration remain
unsupported experiments; do not describe them as an official OpenAI authentication or API.

Licensed under MPL-2.0.

## Custom Responses connections

Companion 0.4.0+ supports custom domains and localhost `/v1/responses` servers. Configure the
endpoint and optional key in extension options, then grant the optional host permission. Approve a
website once under Website access to allow every server. Websites use
`createExtensionResponsesTransport` with a saved connection ID and
`createOpenAICompatibleResponsesModel`; keys and endpoint overrides are not accepted from the page.
ChatGPT sign-in is independent. See [setup and Studio migration](../../docs/local-models.md).

Companion 0.5.0 adds `listExtensionResponsesModels({ runtime, extensionId, sessionId })` to merge
all approved server catalogues. Entries contain stable server-qualified IDs plus their raw model and
connection ID. One Companion-wide website approval covers all servers. Use those fields when
constructing the model/transport; keys never leave Companion. Discovery uses only each saved
endpoint’s sibling `/v1/models`, bounded to eight seconds and 256 KiB per server. Offline servers
are reported separately from successful results.

With Companion 0.6.0, saved Anthropic and Gemini profiles work through the existing model catalogue
and Responses transport bridge. Select the returned raw model and connection ID; the extension
selects the native contract and supplies credentials.
