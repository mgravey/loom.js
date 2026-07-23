# `@mgravey/loom-agent-codex`

Provider-neutral streamed model/tool orchestration for Loom.js coding agents. The package defines
the model protocol, tool contracts, errors, and runtime plugin without embedding credentials or a
provider transport.

```sh
pnpm add @mgravey/loom-agent-codex
```

Supply a compatible model implementation, such as `@mgravey/loom-model-openai-responses`, and only
grant tools the narrow authority required by the application.

Agent requests may include bounded opaque `contextItems` produced by a compatible model compactor.
The agent installs those items before ordinary messages on every model turn and never interprets
their provider-specific fields. If a model error explicitly sets `contextCompactionRequired: true`,
a model with `compact()` is compacted once and the failed turn is retried, provided no partial
output was emitted.

Licensed under MPL-2.0.
