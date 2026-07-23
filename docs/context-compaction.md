# Context compaction

The experimental Codex path supports provider-native context compaction without turning an opaque
provider checkpoint into a Loom-authored text summary. This preserves model-required encrypted
continuation state and keeps credentials and endpoint selection inside the extension.

## Wire flow

1. `@mgravey/loom-coding` projects the current checkpoint, uncompacted transcript suffix, and next
   prompt into a bounded character estimate.
2. When an explicitly configured threshold is reached, it calls the model's `compact()` method.
3. `@mgravey/loom-model-codex-experimental` creates a non-streaming compaction envelope and sends a
   credential-free transport request with `operation: 'compact'`.
4. The Companion passes only that validated operation and body to the extension.
5. The extension selects `/backend-api/codex/responses/compact`, owns authentication and routing
   headers, and streams the successful JSON response back.
6. The model accepts at most 4 MiB, requires one through 2,000 JSON-object output items, freezes the
   items, and returns them without interpreting provider-private fields.

If generation rejects with a context-window provider code, the model error sets
`contextCompactionRequired: true`. The agent can then compact the history accumulated inside the
current run and retry the failed turn once. It does this only before any partial text, tool call, or
continuation item has escaped, avoiding duplicate visible work.

Generation and compaction are distinct operations. A website cannot choose an upstream URL, attach
headers, or access credentials. Non-2xx compaction failures use the same sanitized provider error
metadata and Retry-After path as generation.

## Coding checkpoints

Compaction is opt-in:

```ts
const session = createCodingSession({
  model,
  tools,
  transcript,
  contextCheckpoint: savedCheckpoint,
  contextCompaction: { maximumCharacters: 500_000 },
});
```

`session.contextCheckpoint` and the `context-compacted` event expose:

```ts
{
  items: readonly JsonObject[];
  coveredTranscriptEntries: number;
}
```

Persist this record atomically with the matching transcript. On restore, Loom validates that the
covered count is within the supplied transcript, replays the opaque items, and sends only later
transcript entries as plain text. The public transcript is never deleted or rewritten by compaction.

## Limits and failure behavior

- Compaction is disabled by default.
- The threshold must be an integer from 1 through 16 MiB.
- A checkpoint and a compact response may contain at most 2,000 object items.
- A malformed, empty, oversized, cancelled, or rejected compaction fails the active submission
  without installing a partial checkpoint.
- A second context overflow after the one reactive compaction is surfaced as `MODEL_FAILURE`; Loom
  does not loop indefinitely.
- Raw compact response captures can contain conversation content. Local debugging exports belong in
  `context-compaction-dumps/`, which is ignored by Git.
