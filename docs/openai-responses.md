# OpenAI Platform Responses adapter

`@loom/model-openai-responses` connects the provider-neutral `@loom/agent-codex` protocol to the
documented OpenAI Platform Responses API. It is independent of the experimental
ChatGPT-authenticated Codex transport and does not use the undocumented ChatGPT backend.

The adapter follows OpenAI's
[Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling):
it sends stateless requests with `store: false`, preserves every returned output item, copies nested
`caller` metadata onto function results, and continues until a final assistant `message` exists.

## Trust boundary

Prefer the credential-free transport mode:

```text
Loom agent -> @loom/model-openai-responses -> application transport -> trusted backend
                                                               `-----> POST /v1/responses
```

The injected transport receives a non-streaming JSON request body and returns a complete JSON
response. It owns authentication, endpoint selection, networking, rate limits, and response-size
controls. A browser page must never receive a Platform API key. Direct mode exists only for trusted
hosts and requires both an injected credential supplier and an injected fetch implementation; the
package never reads environment variables or a global `fetch`.

Tests use deterministic local transports and do not contact OpenAI.

## Composition

```ts
import { createOpenAIResponsesModelPlugin } from '@loom/model-openai-responses';

const modelPlugin = createOpenAIResponsesModelPlugin({
  model: 'gpt-5.6',
  transport: {
    async send(request) {
      // Forward request.body from a trusted application transport to
      // POST https://api.openai.com/v1/responses and return sanitized JSON.
      return secureResponsesBackend.send(request);
    },
  },
});
```

The application composes this plugin alongside `@loom/agent-codex` and the three workspace tools,
then resolves the model capability through `OPENAI_RESPONSES_MODEL_KEY`. Model availability is
project-dependent; confirm support before enabling Programmatic Tool Calling. Set
`programmaticToolCalling: false` to use ordinary direct function calls with a model that does not
support the hosted tool.

## Tool policy

The agent publishes structured input and output schemas for every workspace tool:

| Operation              | Direct | Programmatic | Execution policy                  |
| ---------------------- | ------ | ------------ | --------------------------------- |
| `workspace/list-files` | Yes    | Yes          | Parallel when nested in a program |
| `workspace/read-file`  | Yes    | Yes          | Parallel when nested in a program |
| `workspace/write-file` | Yes    | No           | Serial, direct-only               |

The request's `allowed_callers` prevents a hosted program from selecting the write tool. The agent
also validates caller metadata and rejects a programmatic write locally. This second check preserves
the authorization boundary if a provider or custom adapter returns an invalid call.

Programmatic calls are appropriate for bounded read-only discovery where JavaScript can batch,
filter, join, validate, or reduce results. Direct calls remain appropriate when each result needs
new model judgment and for every side effect.

## Stateless continuation

Each completed API response can contain opaque reasoning, `program`, `function_call`,
`program_output`, and `message` items. The adapter emits every item as a normalized `continuation`
event. The agent stores these items unchanged on its assistant transcript entry.

When client-owned functions are pending, the agent executes them and appends `function_call_output`
entries with the original `call_id` and `caller`. When a response contains no pending function call
and no final message, the model emits `{ type: 'completed', final: false }`, causing another
stateless request with the complete ordered transcript. The run ends only after a final assistant
message.

Incomplete responses, malformed JSON, unknown tools, invalid callers, rejected HTTP responses, and
transport failures become sanitized typed errors. Raw provider error bodies and credentials are not
included in exceptions.

## Verification

Run the focused checks with:

```sh
pnpm exec vitest run packages/agent-codex/test/agent-codex.test.ts \
  packages/model-openai-responses/test/model-openai-responses.test.ts
pnpm typecheck
```

Run `pnpm check` before release. No OpenAI credential is required.
