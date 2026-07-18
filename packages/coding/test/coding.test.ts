import type { CodexModel } from '@loom/agent-codex';
import type { ExecutionRuntime } from '@loom/plugin-api';
import { WORKSPACE_OPERATIONS, type WorkspaceTool } from '@loom/tool-workspace';
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
