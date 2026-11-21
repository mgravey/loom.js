---
'@mgravey/loom-auth-chatgpt-browser': minor
---

Add an optional `redirectBroker` to `createChatGPTBrowserClient` so pages outside
`http://127.0.0.1:<port>` can sign in through a helper that owns the sign-in window and captures the
loopback callback (for example the Loom.js Companion extension). The client still generates state,
nonce and PKCE, exchanges the code, verifies the ID token and keeps tokens in memory.
`detectChatGPTBrowserSupport(environment, { redirectBroker: true })` reports
`mode: 'redirect-broker'`. Behaviour without a broker is unchanged.
