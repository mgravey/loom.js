# ADR-015: Fall back to the extension after a direct pre-response failure

- Status: Accepted
- Date: 2026-07-19
- Amends: ADR-013

## Context

The browser exposes CORS rejection and generic connection failure through the same rejected `fetch`
promise, before an HTTP response is available. The experimental ChatGPT endpoint may therefore be
unusable directly even when authentication and request shape are valid.

## Decision

Start with direct model requests from the approved workbench. If and only if an attempt fails before
an HTTP response, retry the credential-free request body through an authorized extension Port and
keep using that relay for the remaining page session. The extension obtains its own short-lived
token, adds routing headers, and streams the provider response back. Do not relay page authorization
headers or add repeated fallback notices to the conversation.

Do not fall back for HTTP responses, response-body failures, validation errors, or cancellation.
Restore only the narrow ChatGPT model host permission required by the fallback.

## Consequences

Direct requests remain visible in the page Network panel when CORS permits them. During fallback,
the extension processes the prompt, selected context, tool traffic, and response stream. Console
diagnostics disclose only transport state and bounded provider metadata, never credentials or model
content.

The relay choice is stored only in tab-scoped session storage, keyed by extension ID. Reloading the
same tab keeps the relay choice; opening a new tab gives direct transport one fresh attempt.
