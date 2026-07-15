# ADR-007: Explicit browser host injection

- Status: Accepted
- Date: 2026-07-15

## Context

Browser plugins need APIs such as IndexedDB and File System Access, but reading ambient globals or
probing for features inside a plugin would hide composition decisions and make window/worker tests
less deterministic. Directory selection also requires application-owned user interaction.

## Decision

Require browser host primitives and directory handles as plugin factory inputs. Browser plugins may
compile against browser types, but they must not introduce browser APIs into core or use ambient
globals as defaults. Register each implementation under an explicit capability ID. Keep permission
pickers and unsupported-host policy in the application.

Use OPFS directory handles for automated compatibility tests because they exercise the same handle
contract without embedding a permission prompt in the runtime.

## Consequences

Application composition is slightly more explicit, and host objects appear in browser-plugin public
APIs. In return, plugins remain testable, multiple browser implementations can coexist, user
gestures stay at the UI boundary, and core requires no feature detection or browser-specific
lifecycle path.
