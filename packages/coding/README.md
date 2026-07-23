# `@mgravey/loom-coding`

High-level reusable coding sessions for Loom.js, including prompts, streamed events, follow-ups,
cancellation, transcripts, custom tools, and optional runtime dispatch.

```sh
pnpm add @mgravey/loom-coding
```

```ts
import { createCodingSession } from '@mgravey/loom-coding';

const session = createCodingSession({ model, tools });
```

Models that implement `compact()` can opt into provider-native context compaction:

```ts
const session = createCodingSession({
  model,
  tools,
  transcript,
  contextCheckpoint: savedCheckpoint,
  contextCompaction: { maximumCharacters: 500_000 },
});

session.subscribe((event) => {
  if (event.type === 'context-compacted') saveCheckpoint(event.checkpoint);
});
```

The public transcript remains complete. A checkpoint contains opaque model items plus the number of
leading transcript entries they replace; persist both together. Compaction is disabled unless
`contextCompaction` is supplied.

See the [getting-started guide](../../docs/getting-started.md) for a complete in-memory example.

Licensed under MPL-2.0.
