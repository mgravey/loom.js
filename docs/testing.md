# Testing and acceptance

## Local workflow

For a clean verification matching CI, use Node.js 22 and pnpm 11.7.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

On Linux or in a minimal container, use `pnpm exec playwright install --with-deps chromium` instead.
The browser command is a one-time setup per Playwright version; subsequent verification runs need
only `pnpm check` when the frozen dependency graph is already installed.

No OpenAI credential, refresh token, unpacked extension, or live OAuth endpoint is required. The
Phase 5 provider tests use deterministic fakes and a local fixture, and the extension tests launch
ephemeral Chromium profiles themselves. Do not add live authorization to the automated suite.

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

To isolate a failure, run the corresponding stage directly:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm test:browser
```

Keep `pnpm build` before a direct `pnpm test:browser` run because the browser suite imports the
published ESM artifacts from each package's `dist` directory. The aggregate `pnpm test` and
`pnpm check` commands already enforce that order.

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
- experimental model request encoding, chunk-safe SSE parsing, streamed text/tool/completion events,
  cancellation, account routing, model Port origin checks, and credential-free page transport;
- credential status/logout behavior and deletion of extension-owned refresh/routing state.
- coding-session follow-ups, transcript snapshots, cancellation, runtime dispatch, and disposal;
- memory/FSA project binary operations, strict patch atomicity, ZIP traversal/size/ratio defenses,
  folder import, and binary-preserving export;
- QuickJS, WebContainer, and Pyodide adapter loading, validation, output, timeout/cancellation,
  snapshot write-back, cleanup, and credential-free request contracts;
- callback bridge tab isolation, DNR cleanup, state/expiry/replay rejection, credential persistence,
  browser-login failure cleanup, and retained device-code fallback;
- classic and Responses Lite body/header separation.

Provider-neutral fakes should cover every capability category while importing only `@loom/types` and
`@loom/plugin-api`. Compile-time fixtures verify public types and package-boundary failures.

## Coverage policy

Across `@loom/types`, `@loom/plugin-api`, `@loom/core`, `@loom/tool-workspace`, `@loom/agent-codex`,
`@loom/coding`, and `@loom/execution-browser`, plus the Platform Responses adapter, Phase 3 browser
plugins, Phase 4 credential packages, and Phase 5 experimental authentication and model packages, V8
coverage must meet:

| Metric     | Minimum |
| ---------- | ------: |
| Statements |     90% |
| Lines      |     90% |
| Functions  |     90% |
| Branches   |     85% |

Browser-only service-worker composition entrypoints are excluded from Node V8 instrumentation and
remain required coverage in the real Chromium extension suites.

Extension callback/options entrypoints, the expanded FSA host adapter, and browser execution engine
bindings are also excluded from Node V8 totals. Their behavior is covered through browser fixtures,
adapter tests, and injected backend contracts; loading the real multi-megabyte WASM distributions is
an opt-in browser smoke check rather than a credential-free unit-suite requirement.

Barrel-only `index.ts` files and test files are excluded. A threshold change requires an explicit
architecture or testing decision, not a silent configuration edit.

## Browser compatibility

Playwright launches real Chromium. One smoke test imports the built public ESM in a browser window;
another performs the same composition and disposal in a dedicated Web Worker. Neither test may rely
on a bundler to rewrite environment-specific imports.

The acceptance commands build packages before compatibility tests. A direct `pnpm test:browser` run
expects an existing build. The production packages compile without DOM or Node types; browser-only
test harness files live outside package source.

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
only from trusted extension UI, stores refresh state only for the Chrome session, and rejects every
external access-token request. Any live compatibility check is manual, opt-in, unsupported, and must
follow the re-audit gate in the [experiment guide](./codex-auth-experiment.md).

Phase 5.5 loads the experimental extension and the built localhost application together. Its local
fixtures complete device authorization, refresh a synthetic access token, stream two synthetic
provider turns over the external Port, execute `workspace/list-files` against an injected OPFS
directory, and verify logout. The page DOM is checked for fixture-secret leakage. See the
[vertical-slice guide](./phase-5-5-vertical-slice.md).

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
