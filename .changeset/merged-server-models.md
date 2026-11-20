---
'@mgravey/loom-companion-codex-experimental': minor
---

Add listExtensionResponsesModels for a merged catalogue of every approved custom server, with
server-qualified selection IDs, per-server failure isolation and extension-only API keys. Requires
Companion 0.5.0. The workbench combines these entries with ChatGPT and saves each conversation's
server.

Website approval is now Companion-wide: any approved website can use every configured server.
Per-server website allowlists are removed, and ChatGPT enablement is independent of this approval.
