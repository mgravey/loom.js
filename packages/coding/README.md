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

See the [getting-started guide](../../docs/getting-started.md) for a complete in-memory example.

Licensed under MPL-2.0.
