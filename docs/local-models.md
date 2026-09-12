# Local and LAN OpenAI-compatible models

The coding workbench can connect directly to a CORS-enabled server that implements the OpenAI
Responses and Models endpoints. This path is independent of the experimental ChatGPT integration: it
does not require Loom.js Companion, OAuth, or an OpenAI account.

## Connect from the workbench

1. Serve the repository workbench from `http://localhost:4173` and open
   `http://localhost:4173/example-codex-experimental/workbench.html`.
2. Select **OpenAI-compatible server** under **Model connection**.
3. Enter an API base URL including `/v1`, such as `http://localhost:11434/v1`.
4. Enter the server's Bearer API key when authentication is enabled, then select **Connect**.
5. Choose a discovered model or type an exact model ID when `/v1/models` is unavailable.

Connect is an explicit network action. The workbench derives only `GET /v1/models` and
`POST /v1/responses` from the supplied base URL. It rejects embedded URL credentials, query
parameters, fragments, non-HTTP schemes, and redirects. Requests omit cookies and browser
credentials.

The base URL, selected model, connection type, and API key are stored in origin-scoped browser
storage. The key is masked in the UI, excluded from logs, diagnostics, workspaces, conversations,
and execution runtimes, and can be removed with **Clear API key**. Browser storage is not an
encrypted credential vault; use a scoped key and a private browser profile.

## Ollama

Ollama documents OpenAI-compatible `/v1/models` and `/v1/responses` endpoints, streaming, and
function tools. Start with the default workbench URL:

```text
http://localhost:11434/v1
```

Pull a tool-capable model before connecting. For LAN access, configure `OLLAMA_HOST` to bind a
network interface and `OLLAMA_ORIGINS` to include the exact workbench origin. Do not expose an
unauthenticated Ollama listener to an untrusted network. See the official
[OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and
[network/CORS FAQ](https://docs.ollama.com/faq).

## LM Studio

Start the LM Studio API server and use its default base URL:

```text
http://localhost:1234/v1
```

In server settings, enable CORS for browser access, enable **Serve on Local Network** only when
needed, and enable authentication before exposing the service beyond loopback. LM Studio documents
Responses SSE events and custom tool support. See the official
[Responses endpoint](https://lmstudio.ai/docs/developer/openai-compat/responses) and
[server settings](https://lmstudio.ai/docs/developer/core/server/settings).

## Streaming and compatibility

The adapter requests `stream: true`. A server may return standard Responses SSE events or ignore
streaming and return one complete JSON response; both paths produce the same Loom model events.
Streamed tool-call arguments are buffered until valid JSON is complete. A request is never replayed
after streamed content begins, preventing duplicate tool execution.

Only the portable Responses subset is sent: model, instructions, input items, ordinary function
tools, and the stream flag. OpenAI Platform-specific hosted programs, `allowed_callers`, output
schemas, encrypted reasoning continuation, and optional reasoning/text controls are omitted. The
agent still enforces direct-only write policy locally.

The selected model must support reliable function calling and enough context for instructions,
workspace schemas, file content, tool results, and the answer. A text-only model may answer prompts
but cannot operate the coding workspace reliably.

## Browser network limits

The direct path requires the server to allow the workbench origin, `GET`/`POST`/`OPTIONS`, and the
`Accept`, `Authorization`, and `Content-Type` headers. CORS failures and connection failures are not
relayed through the extension.

An HTTP endpoint is supported from the locally served HTTP workbench. The production HTTPS site
requires an HTTPS model endpoint because browsers block or restrict HTTPS pages from reaching HTTP
LAN services. Put TLS on the model server or a trusted reverse proxy when using the hosted site. The
Companion extension receives no additional host permissions for this feature.
