# ADR-011: Isolate Platform Responses and preserve hosted-program continuations

- Status: Accepted
- Date: 2026-07-18

## Context

The Phase 2 Codex-style agent originally represented only text, ordinary function calls, function
results, and a per-turn completion marker. It executed all tools serially. OpenAI's documented
Programmatic Tool Calling contract adds hosted `program` and `program_output` items, nested function
calls with caller metadata, and stateless continuation rules that require replaying every response
item until a final assistant message exists.

The existing `@loom/model-codex-experimental` package targets an audited, undocumented
ChatGPT-authenticated backend and a classic Responses-style protocol. Treating that experiment as
the documented Platform API would erase an important support and credential boundary.

## Decision

Add `@loom/model-openai-responses` as a separate provider leaf for the documented OpenAI Platform
Responses API. Its preferred composition accepts a credential-free transport owned by a trusted
application backend. A direct authenticated mode is available only through explicitly injected host
services; the package does not read environment variables or global network APIs.

Extend the agent-owned model protocol with opaque continuation items, optional caller metadata,
structured output schemas, caller policies, and a completion marker that distinguishes an API
response from a final assistant message. Keep these additions out of Core and `@loom/plugin-api`.

Configure list and read tools for direct or programmatic use. Configure writes as direct-only and
reject any write attributed to a hosted program inside the agent. Execute consecutive nested
read-only calls concurrently while retaining serial execution for direct calls.

Use stateless `store: false` requests and replay every returned output item plus every function
result in order. Copy caller metadata without modification so the hosted runtime can resume the
correct program.

## Consequences

Loom can use documented hosted programs for bounded, read-heavy coding workflows without executing
model-generated JavaScript locally. Large intermediate tool results can remain inside the hosted
runtime, and independent nested reads can overlap.

The agent protocol grows beyond the original Phase 2 message abstraction, but the new fields remain
provider-neutral and optional. Existing scripted and experimental adapters continue to work without
emitting continuation items.

Applications still own API credentials, networking, rate limits, model entitlement, and deployment.
The adapter does not make the experimental ChatGPT authentication path supported, and it does not
provide a local shell or general-purpose execution runtime.
