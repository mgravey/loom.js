# `@mgravey/loom-agent-codex`

Provider-neutral streamed model/tool orchestration for Loom.js coding agents. The package defines
the model protocol, tool contracts, errors, and runtime plugin without embedding credentials or a
provider transport.

```sh
pnpm add @mgravey/loom-agent-codex
```

Supply a compatible model implementation, such as `@mgravey/loom-model-openai-responses`, and only
grant tools the narrow authority required by the application.

Licensed under MPL-2.0.
