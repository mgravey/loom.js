---
'@mgravey/loom-companion-codex-experimental': minor
---

Add the page side of the Companion's website ChatGPT sign-in helper:
`getCompanionChatGPTHelperStatus()`, `createCompanionChatGPTHelper()` and
`connectCompanionChatGPTHelper()` return a redirect broker and a `fetch` that relays only OpenAI's
discovery, JWKS, `GET /v1/models` and streaming `POST /v1/responses` through an approved Companion,
with abort propagation and backpressure. They plug into `@mgravey/loom-auth-chatgpt-browser` without
a package dependency.
