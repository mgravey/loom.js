# `@mgravey/loom-model-openai-responses`

Adapters from the Loom.js coding-agent protocol to the documented OpenAI Platform Responses API and
to the portable subset implemented by local or network OpenAI-compatible servers.

```sh
pnpm add @mgravey/loom-model-openai-responses
```

`createOpenAIResponsesModel` retains the Platform request, secure-transport preference, and
programmatic tool continuations. `createOpenAICompatibleResponsesModel` targets an explicit endpoint
or injected `OpenAICompatibleResponsesTransport`, requests SSE, accepts complete JSON fallback, and
omits Platform-only fields. Injected transports receive the prepared request and return its HTTP
response, allowing browser-held OAuth sessions without an API-key configuration. Direct
endpoint/fetch options continue to support optional Bearer authentication.

The package reads neither environment variables nor global `fetch`. Applications must inject a
transport or host fetch adapter. Do not persist Platform keys in browser pages; local-server key
storage and CORS policy remain application decisions.

See the [OpenAI Responses guide](../../docs/openai-responses.md) and
[local/LAN setup guide](../../docs/local-models.md).

Licensed under MPL-2.0.
