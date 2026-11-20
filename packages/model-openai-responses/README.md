# `@mgravey/loom-model-openai-responses`

Adapters from the Loom.js coding-agent protocol to the documented OpenAI Platform Responses API and
to the portable subset implemented by local or network OpenAI-compatible servers.

```sh
pnpm add @mgravey/loom-model-openai-responses
```

`createOpenAIResponsesModel` retains the Platform request, secure-transport preference, and
programmatic tool continuations. `createOpenAICompatibleResponsesModel` targets an explicit endpoint
or injected transport, requests SSE, accepts complete JSON fallback, and omits Platform-only fields.
Browser applications can pair it with Companion’s
`createExtensionResponsesTransport({ runtime: chrome.runtime, connectionId, sessionId })` to keep
API keys in extension settings.

The package reads neither environment variables nor global `fetch`. Applications must inject a
transport or host fetch adapter. Use the extension transport for browser custom servers; direct
endpoint/fetch/authentication options remain available for trusted-host integrations.

See the [OpenAI Responses guide](../../docs/openai-responses.md) and
[local/LAN setup guide](../../docs/local-models.md).

Licensed under MPL-2.0.
