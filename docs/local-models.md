# Model servers through Companion

The coding workbench supports standard `POST /v1/responses` servers on custom HTTP(S) domains,
including localhost and LAN addresses. Companion owns the endpoint, optional Bearer API key and
upstream fetch. One Companion website approval grants access to every configured server. The website
receives model responses and non-secret connection metadata; it stores only the connection ID,
selected model, provider choice and extension ID.

## Connect

1. Install or reload Companion **0.6.0 or later**. Open its extension options page.
2. Under **Model servers**, select a provider, then choose a connection ID (for example `local`),
   label and API base URL, such as `http://localhost:11434/v1/`. Companion appends `models` for
   discovery and `responses` for generation. Reverse proxy prefixes and legacy full Responses URLs
   work too.
3. Enter an optional API key **in extension settings only**. Leave it blank for an unauthenticated
   local server. There is no per-server website allowlist.
4. Select **Save connection and allow server** and approve Chrome's host permission prompt.
   Companion checks the model catalogue with an eight-second timeout and reports availability or a
   warning. Unavailable servers can still be saved. This check does not run a generation.
5. Repeat with a different connection ID for every additional server.
6. Open the workbench with the Companion extension ID and approve its request under Companion’s
   **Website access** section. This approval covers all current and future servers. **Available
   models** automatically combines approved server catalogues; **Refresh models** reloads them.
   Every catalogue request fetches fresh models from every server with caching disabled, reflecting
   additions and removals. Choose an entry such as `Home Ollama (home) / qwen3:8b` or
   `GPU server (gpu) / qwen3:8b`. This single selection chooses both the server and its raw model
   ID. ChatGPT models share the list when available.

Discovery calls each approved endpoint's sibling `GET /v1/models` through the extension using that
server's own optional key. Names are prefixed with the server label and ID, so identical model IDs
on different servers stay distinct. The prefix is never sent as the upstream model name. Offline,
malformed or unsupported catalogues are omitted without losing successful results. Discovery does
not verify tool support or guarantee that a listed model can generate successfully.

For servers without `/v1/models`, the manual **Model connection**, **Companion connection ID**,
**Connect** and **Model** fields remain available. Connect verifies the saved grant; the first
request verifies generation. Custom servers require neither ChatGPT sign-in nor the Codex toggle.
The website must also match the extension's existing `externally_connectable` allowlist; saving a
connection does not widen that allowlist.

For Ollama, the usual base URL is `http://localhost:11434/v1/`. Use a model with function calling
support for workspace tools. Ollama documents Responses streaming and tools but only non-stateful
Responses: Loom sends the transcript instead of relying on `previous_response_id`. See
[Ollama's official OpenAI compatibility documentation](https://docs.ollama.com/api/openai-compatibility).
No live Ollama deployment was tested for this change; regression tests use a local Responses
fixture. Other servers must implement Responses, not just `/v1/chat/completions`.

## Website / Studio integration

Upgrade `@mgravey/loom-companion-codex-experimental` and `@mgravey/loom-model-openai-responses`
together to releases containing the custom transport factories, and rebuild the website:

```ts
import { createExtensionResponsesTransport } from '@mgravey/loom-companion-codex-experimental';
import { createOpenAICompatibleResponsesModel } from '@mgravey/loom-model-openai-responses';

const model = createOpenAICompatibleResponsesModel({
  model: 'gpt-oss:20b',
  transport: createExtensionResponsesTransport({
    runtime: chrome.runtime,
    extensionId: companionExtensionId,
    connectionId: 'local',
    sessionId: studioSessionId,
  }),
});
```

Use this model with the existing coding session and workspace tools. The website supplies no key,
URL or headers.
`getExtensionResponsesConnection({ runtime: chrome.runtime, extensionId, connectionId, sessionId })`
checks access and returns only `{ id, label, endpoint }`. Do not add an endpoint or authentication
property to the brokered model options; mixed direct and brokered options are rejected.

For your own merged selector:

```ts
import {
  listExtensionResponsesModels,
  requestCompanionOriginAccess,
} from '@mgravey/loom-companion-codex-experimental';

const access = await requestCompanionOriginAccess({
  runtime: chrome.runtime,
  extensionId: companionExtensionId,
});
// If access.approved is false, the user approves the website in Companion and retries.
const catalogue = await listExtensionResponsesModels({
  runtime: chrome.runtime,
  extensionId: companionExtensionId,
  sessionId: studioSessionId,
});
// Each entry: { id, model, connectionId, serverLabel }.
// Use entry.id as the selector value (e.g. responses:home/org/model:latest).
// Pass entry.model to the model factory and entry.connectionId to the transport above.
// Show catalogue.unavailableConnections separately; successful entries remain usable.
```

Existing per-server origin lists from 0.4.0 are no longer used. Existing Companion website grants
apply to all servers; websites that only had a per-server grant need approval once under **Website
access**. Saved endpoints and keys are retained.

The workbench saves connection IDs in version-three conversation records. Reopening a conversation
restores its server, never another connection that happens to offer the same model name. Older
custom conversations without a saved server require an explicit model/server selection or Connect.

The workbench deletes legacy `loom.local-model.api-key` website storage on loading. Users must
re-enter that key in extension settings; it is never automatically transferred. Existing direct
`{ endpoint, fetch, authentication }` library integrations remain available for trusted hosts but
are not used by this workbench.

## Contract and limits

Requests use ordinary Responses JSON with function tools, `stream: true` by default and
`store: false`. Both standard SSE and complete JSON responses are supported. Optional reasoning
effort is sent only when configured. Codex `responses-lite`, Codex compaction triggers, account
routing and ChatGPT headers are never sent to custom connections. Generic automatic compaction is
not provided; context limits remain the selected server/model's responsibility.

Catalogue discovery is bounded to 32 approved profiles, 500 models and 256 KiB per server, with an
eight-second fetch/body deadline for each server. It never retries automatically.

The relay retains its 4 MiB request-character limit, adds an 8 MiB response-character limit and a
five-minute overall custom request deadline, and cancels upstream work on disconnect or consumer
cancellation. Generation is never automatically replayed after a transport failure. Full tool calls
and results remain in the session transcript for continuation.

## Permissions and key lifecycle

Approve a website once in **Website access** to let it discover and use every configured server and
model, including servers added later. **Revoke** removes access to all of them. These grants remain
until revoked, extension data is cleared or Companion is uninstalled; disabling the ChatGPT
experiment does not revoke Companion-wide website access. Chrome’s server host permissions are
requested when saving a server. The selected model’s connection ID supplies its saved endpoint and
key inside the extension. Redirects, URL credentials, query strings and fragments are rejected;
cookies are omitted. Responses server requests do not use website fetch or depend on website
CORS/mixed-content access. Server-side network policy and browser/OS local-network permissions can
still deny a connection.

Keys are stored in trusted extension **local** storage, persist across browser restarts and are
never synced by Loom. This is not an encrypted vault. Editing a connection requires re-entering its
key; a blank key clears it. **Remove** deletes the profile and key; uninstall/clear extension data
also deletes them. Removing a profile prevents new requests; an already running request may finish.
ChatGPT logout/disable affects ChatGPT credentials, not these independent custom connections.
Removing a profile does not revoke the Chrome host grant because other profiles may use it; revoke
host access in Chrome's extension controls when needed. HTTPS protects remote keys in transit; an
HTTP connection sends them without TLS.

The optional permission and storage design follows Chrome's official
[permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions),
[cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
and [trusted storage access](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Troubleshooting server setup

Use Companion 0.5.1 or later for stage-specific setup errors. If Chrome does not grant server
access, reload the updated unpacked extension at chrome://extensions, reopen options and save again,
accepting the host permission prompt. A valid base URL such as `http://127.0.0.1:10001/v1` does not
require a trailing slash. A model discovery warning still saves the server; permission, field and
storage errors prevent saving. No raw provider or browser error payloads are displayed.

## Anthropic and Google Gemini

Select **Anthropic Claude** or **Google Gemini** in the Provider selector. This fills the default
base URL; custom domains and local proxies remain supported. Save each account/server under a
different connection ID. Existing profiles default to Responses and keep their keys.

| Provider             | Default base URL                                    | Authentication      | Generation                       |
| -------------------- | --------------------------------------------------- | ------------------- | -------------------------------- |
| Responses-compatible | `http://localhost:11434/v1/`                        | Optional Bearer key | `responses`                      |
| Anthropic Claude     | `https://api.anthropic.com/v1/`                     | `x-api-key`         | `messages`                       |
| Google Gemini        | `https://generativelanguage.googleapis.com/v1beta/` | `x-goog-api-key`    | `models/{model}:generateContent` |

Keys are entered only in Companion settings. Changing provider clears the unsaved key. The model
list is refreshed on every request, following Anthropic and Gemini pagination with a shared
eight-second timeout, ten-page limit, 256 KiB response budget and 500-model limit per server. Gemini
lists only models advertising `generateContent`. Availability probes do not generate text or execute
tools.

Native Anthropic and Gemini support text and function tools. Their JSON responses are buffered and
validated before delivery; Responses-compatible servers retain SSE streaming. Anthropic uses a
4,096-token output cap. Provider-default thinking settings apply to native providers; the workbench
Thinking level applies to Codex and Responses servers. Multimodal input, provider-hosted tools,
Vertex AI/Bedrock authentication, and native compaction are not implemented. Incomplete, blocked or
unsupported output fails rather than fabricating a successful response. There is no automatic
generation replay.

Native tool blocks, reasoning signatures and Gemini thought signatures survive continuation
unchanged. Start a new conversation when switching provider families; incompatible opaque history is
rejected rather than discarded. All providers use the existing origin approval, saved-host
permission, credential isolation, cancellation, five-minute generation deadline and request/response
size limits. No new site-level credentials or authenticated arbitrary URL API are introduced.

Studio can keep using `listExtensionResponsesModels` and `createExtensionResponsesTransport`. The
`responses:` selector prefix remains a backward-compatible routing identifier for every saved
server; Companion selects the actual provider from its trusted profile. Upgrade Companion to 0.6.0
and reload it. No new Studio provider adapter is needed when it already uses this bridge.

Contracts were checked against
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create),
[Anthropic Models](https://platform.claude.com/docs/en/api/models/list),
[Anthropic's official browser headers](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts),
[Gemini generation](https://ai.google.dev/api/generate-content),
[Gemini authentication](https://ai.google.dev/api),
[Gemini Models](https://ai.google.dev/api/models), and
[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
Tests use local provider fixtures and the real extension. Live Anthropic/Gemini accounts have not
been exercised; account-specific access and model capabilities remain provider-dependent.

For experimental account-based Google access, see
[subscription login setup](subscription-login-experiment.md). It requires a separately configured
Chrome OAuth client and does not use the API-key provider above. Live acceptance remains unverified.
