# Testing and acceptance

## Local workflow

Install the exact workspace dependency graph and Chromium once:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

During development, run the focused commands:

```sh
pnpm typecheck
pnpm test:unit
pnpm lint
```

Before handing off a change, run the complete acceptance suite:

```sh
pnpm check
```

The complete check verifies formatting, lint and import boundaries, the strict TypeScript
project-reference graph, coverage, ESM/declaration builds, and Chromium window/worker compatibility.

## Unit and integration coverage

Tests must cover:

- capability registration, duplicates, lookups, immutable snapshots, ownership, and cleanup;
- serial event ordering, idempotent unsubscribe, and error-sink isolation;
- service lifetimes, async resolution, missing/circular services, and reverse disposal;
- JSON validation, deep cloning/freezing, unknown plugin keys, and session overlays;
- lifecycle order, invalid transitions, graph validation, initialization/start rollback, and
  aggregate cleanup failures;
- session isolation, cancellation, duplicate IDs, closing order, and idempotent close;
- independence of multiple runtime instances.
- normalized workspace-path and list/read/write input validation;
- minimal-agent event ordering, tool-result feedback, cancellation propagation, malformed model
  output, failure wrapping, and bounded-turn behavior;
- public-only composition of an explicitly selected model, agent, and tool set.
- explicit browser-platform registration without ambient-global fallback;
- IndexedDB byte cloning, namespace isolation, deterministic listing, error mapping, and disposal;
- File System Access path confinement, immediate listing, UTF-8 reads/writes, cancellation, and
  browser-error translation.
- strict credential-protocol validation, immutable normalization, request/response correlation, and
  provider-neutral error mapping;
- exact sender-origin authorization, trusted-context storage initialization, credential rotation,
  token expiry/skew handling, failure sanitization, and concurrent refresh deduplication;
- external-message adaptation to the public Loom `AuthProvider` contract.
- host-neutral credential-provider errors, authorization-result persistence ordering, permanent
  refresh rejection cleanup, and preservation of non-rotated refresh credentials;
- audited Codex refresh request shape, device-code issuance/polling/timeout, server-supplied PKCE
  validation, direct S256/state/callback handling, response sanitization, and explicit experiment
  gates.

Provider-neutral fakes should cover every capability category while importing only `@loom/types` and
`@loom/plugin-api`. Compile-time fixtures verify public types and package-boundary failures.

## Coverage policy

Across `@loom/types`, `@loom/plugin-api`, `@loom/core`, `@loom/tool-workspace`, and
`@loom/agent-codex`, plus the Phase 3 browser plugins, Phase 4 credential packages, and Phase 5
experimental authentication packages, V8 coverage must meet:

| Metric     | Minimum |
| ---------- | ------: |
| Statements |     90% |
| Lines      |     90% |
| Functions  |     90% |
| Branches   |     85% |

Barrel-only `index.ts` files and test files are excluded. A threshold change requires an explicit
architecture or testing decision, not a silent configuration edit.

## Browser compatibility

Playwright launches real Chromium. One smoke test imports the built public ESM in a browser window;
another performs the same composition and disposal in a dedicated Web Worker. Neither test may rely
on a bundler to rewrite environment-specific imports.

Compatibility tests build packages first. The production packages compile without DOM or Node types;
browser-only test harness files live outside package source.

Phase 2 repeats the window and worker smoke path with the built agent package, scripted model, and
in-memory workspace. The scenario must perform list, read, and write operations, verify the written
text, close its session, and dispose the runtime.

Phase 3 repeats that composition with real IndexedDB and OPFS directory handles in both a Chromium
window and dedicated Worker. It verifies copied byte storage, namespace listing/deletion, actual
file mutation through the File System Access contract, session cancellation, connection closure, and
runtime disposal. Interactive directory-picker behavior remains in the example application;
automated tests inject an OPFS handle to avoid a permission prompt.

Phase 4 loads the built Manifest V3 extension into a persistent Chromium context and communicates
with its real service worker from a served page. Tests cover the public example, exact-origin
rejection, concurrent refresh deduplication, an unknown provider, and a missing refresh credential
without leaking stored state. This follows Playwright's
[Chrome extension guidance](https://playwright.dev/docs/chrome-extensions) and Chrome's
[end-to-end extension testing guidance](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing).

Phase 5 tests provider behavior against deterministic in-process fakes and a local OAuth fixture. CI
must never contact the real OpenAI authorization or token endpoints. Chromium loads only the
separate experimental extension and verifies that authorization is off by default, can be initiated
only from trusted extension UI, and never returns refresh credentials through the external broker.
Any live compatibility check is manual, opt-in, unsupported, and must follow the re-audit gate in
the [experiment guide](./codex-auth-experiment.md).

## CI

GitHub Actions uses Node.js 22, the package-manager version declared in `package.json`, a frozen
lockfile, and a pinned Chromium install from Playwright. The workflow grants read-only repository
permissions and runs `pnpm check`.

Acceptance requires:

1. a clean `pnpm install --frozen-lockfile`;
2. a successful `pnpm check`;
3. valid explicit ESM and declaration exports for every package;
4. successful browser-window and dedicated-worker smoke tests;
5. documentation commands that run as written.
