# `@mgravey/loom-credential-broker-api`

Transport-neutral, versioned, strictly validated request and response protocol for asking a trusted
host—such as a Chrome extension—for a short-lived access token.

```sh
pnpm add @mgravey/loom-credential-broker-api
```

This package contains protocol types and validators only. It does not store refresh credentials,
perform OAuth, or grant browser authority.

See the [credential broker guide](../../docs/credential-broker.md).

Licensed under MPL-2.0.
