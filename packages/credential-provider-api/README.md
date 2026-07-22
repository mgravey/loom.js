# `@mgravey/loom-credential-provider-api`

Host-neutral contracts for credential providers, refresh operations, and interactive authorization.
The interfaces allow an extension or trusted host to own long-lived credentials without exposing
them to websites or agent runtimes.

```sh
pnpm add @mgravey/loom-credential-provider-api
```

Provider implementations remain application-owned. No OpenAI, Codex, or other provider login is
built into this package.

Licensed under MPL-2.0.
