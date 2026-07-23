import type { CodexModel } from '@mgravey/loom-agent-codex';
import type { ExecutionRuntime } from '@mgravey/loom-plugin-api';
import { WORKSPACE_OPERATIONS, type WorkspaceTool } from '@mgravey/loom-tool-workspace';
import { describe, expect, it } from 'vitest';

import { createCodingSession } from '../src/index.js';

const tools = [
  {
    name: 'list',
    operation: WORKSPACE_OPERATIONS.listFiles,
    execute: () => Promise.resolve({ entries: [] }),
  },
  {
    name: 'read',
    operation: WORKSPACE_OPERATIONS.readFile,
    execute: () => Promise.resolve({ path: 'a', content: '' }),
  },
  {
    name: 'write',
    operation: WORKSPACE_OPERATIONS.writeFile,
    execute: () => Promise.resolve({ path: 'a', created: true }),
  },
] as unknown as readonly WorkspaceTool[];

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe('coding session', () => {
  it('streams agent events and keeps a follow-up transcript', async () => {
    const prompts: string[] = [];
    const model: CodexModel = {
      async *generate(request) {
        prompts.push(request.messages[0]?.role === 'user' ? request.messages[0].content : '');
        yield { type: 'text', text: 'done' };
        yield { type: 'completed' };
      },
    };
    const session = createCodingSession({ model, tools });
    await collect(session.submit('first'));
    await collect(session.followUp('second'));
    expect(session.transcript).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(prompts[1]).toContain('User: first');
    expect(prompts[1]).toContain('User: second');
  });

  it('resumes a persisted transcript without mutating the supplied entries', async () => {
    const prompts: string[] = [];
    const seed = [{ role: 'user' as const, content: 'remember this decision' }];
    const model: CodexModel = {
      async *generate(request) {
        prompts.push(request.messages[0]?.role === 'user' ? request.messages[0].content : '');
        yield { type: 'text', text: 'continued' };
        yield { type: 'completed' };
      },
    };
    const session = createCodingSession({ model, tools, transcript: seed });
    await collect(session.followUp('what was it?'));
    expect(prompts[0]).toContain('User: remember this decision');
    expect(session.transcript).toEqual([
      ...seed,
      { role: 'user', content: 'what was it?' },
      { role: 'assistant', content: 'continued' },
    ]);
    expect(seed).toEqual([{ role: 'user', content: 'remember this decision' }]);
  });

  it('compacts, replays, and restores a serializable model-native context checkpoint', async () => {
    const generated: Parameters<CodexModel['generate']>[0][] = [];
    const compacted: Parameters<CodexModel['generate']>[0][] = [];
    const model: CodexModel & {
      compact(request: Parameters<CodexModel['generate']>[0]): Promise<{
        readonly items: readonly [{ readonly type: 'compaction'; readonly data: string }];
      }>;
    } = {
      compact(request) {
        compacted.push(request);
        return Promise.resolve({
          items: [{ type: 'compaction', data: 'opaque-checkpoint' }],
        });
      },
      async *generate(request) {
        generated.push(request);
        yield { type: 'text', text: 'continued' };
        yield { type: 'completed' };
      },
    };
    const seed = [
      { role: 'user' as const, content: 'an old decision' },
      { role: 'assistant' as const, content: 'the old result' },
    ];
    const session = createCodingSession({
      model,
      tools,
      transcript: seed,
      contextCompaction: { maximumCharacters: 1 },
    });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    await collect(session.followUp('continue'));

    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.messages).toEqual([seed[0], { ...seed[1], toolCalls: [] }]);
    expect(generated[0]?.contextItems).toEqual([{ type: 'compaction', data: 'opaque-checkpoint' }]);
    expect(generated[0]?.messages[0]).toEqual({ role: 'user', content: 'continue' });
    expect(session.contextCheckpoint).toEqual({
      items: [{ type: 'compaction', data: 'opaque-checkpoint' }],
      coveredTranscriptEntries: 2,
    });
    const savedCheckpoint = session.contextCheckpoint;
    if (savedCheckpoint === undefined) throw new Error('Expected a saved context checkpoint.');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'context-compacted',
          checkpoint: expect.objectContaining({ coveredTranscriptEntries: 2 }),
        }),
      ]),
    );

    const restoredRequests: Parameters<CodexModel['generate']>[0][] = [];
    const restoredModel: typeof model = {
      compact: model.compact,
      async *generate(request) {
        restoredRequests.push(request);
        yield { type: 'completed' };
      },
    };
    const restored = createCodingSession({
      model: restoredModel,
      tools,
      transcript: session.transcript,
      contextCheckpoint: savedCheckpoint,
      contextCompaction: { maximumCharacters: 1_000_000 },
    });
    await collect(restored.followUp('one more'));
    expect(restoredRequests[0]?.contextItems).toEqual([
      { type: 'compaction', data: 'opaque-checkpoint' },
    ]);
    const restoredPrompt =
      restoredRequests[0]?.messages[0]?.role === 'user'
        ? restoredRequests[0].messages[0].content
        : '';
    expect(restoredPrompt).toContain('User: continue');
    expect(restoredPrompt).not.toContain('an old decision');
  });

  it('installs an agent-triggered overflow checkpoint without restarting completed work', async () => {
    let attempts = 0;
    const model: CodexModel & {
      compact(request: Parameters<CodexModel['generate']>[0]): Promise<{
        readonly items: readonly [{ readonly type: 'compaction'; readonly data: string }];
      }>;
    } = {
      compact: () =>
        Promise.resolve({ items: [{ type: 'compaction', data: 'reactive-checkpoint' }] }),
      async *generate() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('context full'), {
            providerCode: 'context_length_exceeded',
            contextCompactionRequired: true,
          });
        }
        yield { type: 'text', text: 'finished' };
        yield { type: 'completed' };
      },
    };
    const session = createCodingSession({ model, tools });

    await collect(session.submit('large request'));

    expect(attempts).toBe(2);
    expect(session.contextCheckpoint).toEqual({
      items: [{ type: 'compaction', data: 'reactive-checkpoint' }],
      coveredTranscriptEntries: 1,
    });
    expect(session.transcript).toEqual([
      { role: 'user', content: 'large request' },
      { role: 'assistant', content: 'finished' },
    ]);
  });

  it('runs an injected execution runtime and rejects overlapping work', async () => {
    const model: CodexModel = {
      async *generate() {
        yield { type: 'completed' };
      },
    };
    const runtime: ExecutionRuntime = {
      async *execute() {
        yield { type: 'stdout', data: 'ok' };
      },
    };
    const session = createCodingSession({ model, tools, runtimes: { node: runtime } });
    await expect(collect(session.execute({ runtime: 'node', request: {} }))).resolves.toEqual([
      { type: 'stdout', data: 'ok' },
    ]);
    await session.dispose();
    await expect(collect(session.submit('after dispose'))).rejects.toThrow('disposed');
  });

  it('publishes lifecycle events and cancels the active operation', async () => {
    const model: CodexModel = {
      async *generate() {
        yield { type: 'completed' };
      },
    };
    const runtime: ExecutionRuntime = {
      async *execute(_request, context) {
        await new Promise<void>((_resolve, reject) => {
          context?.signal?.onCancel(() => reject(new Error('runtime cancelled')));
        });
        yield { type: 'stdout', data: 'unreachable' };
      },
    };
    const session = createCodingSession({ model, tools, runtimes: { node: runtime } });
    const states: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'state') states.push(event.state);
    });
    const iterator = session.execute({ runtime: 'node', request: {} })[Symbol.asyncIterator]();
    const running = iterator.next();
    await Promise.resolve();
    await expect(collect(session.submit('overlap'))).rejects.toThrow('active operation');
    session.cancel('stop');
    await expect(running).rejects.toThrow('runtime cancelled');
    await session.dispose();
    unsubscribe();
    expect(states).toEqual(['running', 'idle', 'disposed']);
  });

  it('validates prompts and runtime selection', async () => {
    const model: CodexModel = {
      async *generate() {
        yield { type: 'completed' };
      },
    };
    const session = createCodingSession({ model, tools });
    await expect(collect(session.submit('   '))).rejects.toThrow('non-empty');
    await expect(collect(session.execute({ runtime: 'missing', request: {} }))).rejects.toThrow(
      'Unknown execution runtime',
    );
    await session.dispose();
    await expect(session.dispose()).resolves.toBeUndefined();
  });
});
