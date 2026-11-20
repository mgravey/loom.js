import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCancellationSource, sessionId } from '@mgravey/loom-types';
import {
  CODEX_AGENT_FACTORY,
  type CodexAgent,
  type CodexModelRequest,
} from '../../agent-codex/src/index.js';
import { createCodingSession } from '../../coding/src/index.js';
import {
  createCodexExperimentalModel,
  type CodexResponsesRequest,
  type CodexResponsesHttpResponse,
} from '../../model-codex-experimental/src/index.js';
import { CodexCompanionError } from '../../companion-codex-experimental/src/index.js';

const request: CodexModelRequest = {
  instructions: 'Keep decisions.',
  tools: [],
  messages: [{ role: 'user', content: 'Original prompt' }],
};
const summary = {
  type: 'compaction',
  encrypted_content: 'opaque-private-context',
  extra: { preserve: true },
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = event({
  type: 'response.completed',
  response: { id: 'resp-1', status: 'completed' },
});
const compactStream = event({ type: 'response.output_item.done', item: summary }) + completed;
async function* chunks(text: string) {
  yield text;
}
function response(text = compactStream, status = 200): CodexResponsesHttpResponse {
  return { status, body: chunks(text), requestId: 'loom-model-13' };
}
async function collect<T>(stream: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}
afterEach(() => vi.useRealTimers());

describe('Codex compaction recovery', () => {
  it('streams a v2 checkpoint then continues responses-lite with opaque items unchanged', async () => {
    const sent: CodexResponsesRequest[] = [];
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      wireProtocol: 'responses-lite',
      transport: {
        async send(value) {
          sent.push(value);
          return response(value.operation === 'compact' ? compactStream : completed);
        },
      },
    });
    const result = await model.compact(request);
    await collect(model.generate({ ...request, contextItems: result.items, messages: [] }));
    const compact = JSON.parse(sent[0]?.body ?? '{}') as { input: unknown[] };
    const generate = JSON.parse(sent[1]?.body ?? '{}') as { input: unknown[] };
    expect(compact.input.at(-1)).toEqual({ type: 'compaction_trigger' });
    expect(generate.input).toContainEqual(summary);
    expect(generate.input).not.toContainEqual({ type: 'compaction_trigger' });
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it('caches 404 per session for five minutes and supports explicit reset', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => response('', 404));
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const ctx = { sessionId: sessionId('one') };
    for (let n = 0; n < 2; n++)
      await expect(model.compact(request, ctx)).rejects.toMatchObject({
        code: 'COMPACTION_UNAVAILABLE',
        status: 404,
        operation: 'compact',
        requestId: 'loom-model-13',
        retryable: false,
      });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(model.compact(request, { sessionId: sessionId('two') })).rejects.toHaveProperty(
      'status',
      404,
    );
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_001);
    await expect(model.compact(request, ctx)).rejects.toHaveProperty('status', 404);
    model.resetCompactionAvailability();
    await expect(model.compact(request, ctx)).rejects.toHaveProperty('status', 404);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('keeps transcript/checkpoint after 404 and continues only under an explicit safe budget', async () => {
    const send = vi.fn(async (value: CodexResponsesRequest) =>
      response(
        value.operation === 'compact' ? '' : completed,
        value.operation === 'compact' ? 404 : 200,
      ),
    );
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const transcript = [{ role: 'user' as const, content: 'Keep this' }];
    const checkpoint = { items: [summary], coveredTranscriptEntries: 0 };
    const session = createCodingSession({
      model,
      tools: [],
      transcript,
      contextCheckpoint: checkpoint,
      contextCompaction: { maximumCharacters: 1 },
    });
    await expect(collect(session.submit('Next'))).rejects.toMatchObject({
      code: 'COMPACTION_UNAVAILABLE',
      contextCompactionRequired: true,
    });
    expect(session.transcript).toEqual(transcript);
    expect(session.contextCheckpoint).toEqual(checkpoint);
    const fallback = createCodingSession({
      model,
      tools: [],
      transcript,
      contextCheckpoint: checkpoint,
      contextCompaction: { maximumCharacters: 1, fallbackMaximumCharacters: 100_000 },
    });
    await collect(fallback.submit('Next'));
    expect(fallback.contextCheckpoint).toEqual(checkpoint);
    expect(fallback.transcript[0]).toEqual(transcript[0]);
    const generation = send.mock.calls.find(([value]) => value.operation === 'generate')?.[0];
    expect(generation?.body).toContain('Keep this');
    expect(generation?.body).toContain('opaque-private-context');
  });

  it.each([
    '{}',
    '{"output":[{}]}',
    completed,
    event({ type: 'response.output_item.done', item: summary }),
    event({ type: 'response.output_item.done', item: { type: 'compaction' } }) + completed,
    compactStream + event({ type: 'response.output_item.done', item: summary }),
  ])('rejects invalid compaction without replacing a checkpoint: %s', async (text) => {
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      transport: {
        async send() {
          return response(text);
        },
      },
    });
    const transcript = [{ role: 'user' as const, content: 'Keep' }];
    const checkpoint = { items: [summary], coveredTranscriptEntries: 0 };
    const session = createCodingSession({
      model,
      tools: [],
      transcript,
      contextCheckpoint: checkpoint,
      contextCompaction: { maximumCharacters: 1 },
    });
    await expect(collect(session.submit('Next'))).rejects.toMatchObject({
      cause: { code: 'MALFORMED_RESPONSE' },
    });
    expect(session.contextCheckpoint).toEqual(checkpoint);
    expect(session.transcript).toEqual(transcript);
  });

  it('retries transient rejections at most three times and respects Retry-After', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ...response('', 429), retryAfterMs: 2_000 }));
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const pending = expect(model.compact(request)).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can recover from a transient rejection without altering the request', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => response()).mockResolvedValueOnce(response('', 503));
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const pending = model.compact(request);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).items).toContainEqual(summary);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancels during retry backoff without retrying or leaking timers', async () => {
    vi.useFakeTimers();
    const source = createCancellationSource();
    const send = vi.fn(async () => ({ ...response('', 503), retryAfterMs: 10_000 }));
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const pending = expect(
      model.compact(request, { signal: source.signal }),
    ).rejects.toHaveProperty('code', 'CANCELLED');
    await vi.advanceTimersByTimeAsync(1);
    source.cancel();
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires the overall deadline even while the transport stalls', async () => {
    vi.useFakeTimers();
    let active: CodexResponsesRequest | undefined;
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      compactionTimeoutMs: 100,
      transport: {
        send(value) {
          active = value;
          return new Promise(() => undefined);
        },
      },
    });
    const pending = expect(model.compact(request)).rejects.toHaveProperty(
      'code',
      'DEADLINE_EXCEEDED',
    );
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(active?.signal?.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 400])(
    'does not retry or cache a nontransient HTTP %s as unsupported',
    async (status) => {
      const send = vi.fn(async () => response('', status));
      const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
      for (let n = 0; n < 2; n++)
        await expect(model.compact(request)).rejects.toMatchObject({
          status,
          code: status === 400 ? 'HTTP_ERROR' : 'AUTHENTICATION_FAILED',
          retryable: false,
        });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it('expires during Retry-After and never starts the next attempt', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ...response('', 429), retryAfterMs: 10_000 }));
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      compactionTimeoutMs: 100,
      transport: { send },
    });
    const pending = expect(model.compact(request)).rejects.toHaveProperty(
      'code',
      'DEADLINE_EXCEEDED',
    );
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an incomplete accepted stream without accepting or replaying its summary', async () => {
    vi.useFakeTimers();
    const source = createCancellationSource();
    let active: CodexResponsesRequest | undefined;
    const send = vi.fn(async (value: CodexResponsesRequest) => {
      active = value;
      return {
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield event({ type: 'response.output_item.done', item: summary });
            await new Promise<void>((resolve) => value.signal?.onCancel(() => resolve()));
          },
        },
      };
    });
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const pending = expect(
      model.compact(request, { signal: source.signal }),
    ).rejects.toHaveProperty('code', 'CANCELLED');
    await vi.advanceTimersByTimeAsync(1);
    source.cancel();
    await pending;
    expect(active?.signal?.cancelled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves sanitized remote causes and distinguishes auth from disconnection', async () => {
    for (const [remoteCode, expected] of [
      ['AUTHENTICATION_FAILED', 'AUTHENTICATION_FAILED'],
      ['PROVIDER_STREAM_FAILED', 'TRANSPORT_FAILED'],
    ] as const) {
      const send = vi.fn(async () => {
        throw new CodexCompanionError('EXTENSION_REQUEST_FAILED', 'private prompt and token', {
          remoteCode,
          requestId: 'loom-model-13',
          stage: 'authentication',
        });
      });
      const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
      const failure = await model.compact(request).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: expected,
        remoteCode,
        requestId: 'loom-model-13',
        cause: { code: 'EXTENSION_REQUEST_FAILED', remoteCode },
      });
      expect(JSON.stringify(failure)).not.toContain('private');
      expect(send).toHaveBeenCalledTimes(1);
    }
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      transport: {
        async send() {
          throw new CodexCompanionError('CONNECTION_FAILED', 'private');
        },
      },
    });
    await expect(model.compact(request)).rejects.toHaveProperty('code', 'EXTENSION_DISCONNECTED');
  });

  it.each([200, 404])(
    'does not execute completed tools again when compaction returns %s',
    async (compactStatus) => {
      let generations = 0;
      const sent: CodexResponsesRequest[] = [];
      const execute = vi.fn(async () => ({ saved: true }));
      const model = createCodexExperimentalModel({
        model: 'gpt-5.6-sol',
        wireProtocol: 'responses-lite',
        transport: {
          async send(value) {
            sent.push(value);
            if (value.operation === 'compact')
              return response(compactStatus === 200 ? compactStream : '', compactStatus);
            generations++;
            if (generations === 1)
              return response(
                event({
                  type: 'response.output_item.done',
                  item: {
                    type: 'function_call',
                    id: 'fc1',
                    call_id: 'call1',
                    name: 'loom_0_save',
                    arguments: '{}',
                  },
                }) +
                  event({
                    type: 'response.output_item.done',
                    item: { type: 'reasoning', encrypted_content: 'keep-opaque' },
                  }) +
                  completed,
              );
            if (generations === 2)
              return { ...response('', 400), providerCode: 'context_length_exceeded' };
            return response(completed);
          },
        },
      });
      const agent = CODEX_AGENT_FACTORY.create({
        model,
        configuration: {},
        tools: [
          {
            name: 'save',
            operation: 'save',
            description: 'Save once',
            inputSchema: { type: 'object' },
            execute,
          },
        ],
      }) as CodexAgent;
      if (compactStatus === 200) await collect(agent.run({ prompt: 'Save' }));
      else
        await expect(collect(agent.run({ prompt: 'Save' }))).rejects.toMatchObject({
          code: 'COMPACTION_UNAVAILABLE',
          contextCompactionRequired: true,
          cause: { code: 'COMPACTION_UNAVAILABLE', status: 404 },
        });
      expect(execute).toHaveBeenCalledTimes(1);
      const compact = sent.find((value) => value.operation === 'compact');
      expect(compact?.body).toContain('function_call_output');
      expect(compact?.body).toContain('call1');
      expect(compact?.body).toContain('keep-opaque');
      expect(generations).toBe(compactStatus === 200 ? 3 : 2);
    },
  );

  it('never replays generation after partial text', async () => {
    const send = vi.fn(async () =>
      response(
        event({ type: 'response.output_text.delta', delta: 'Delivered' }) +
          event({ type: 'error', code: 'context_length_exceeded' }),
      ),
    );
    const model = createCodexExperimentalModel({ model: 'gpt-5.6-sol', transport: { send } });
    const agent = CODEX_AGENT_FACTORY.create({ model, configuration: {}, tools: [] }) as CodexAgent;
    await expect(collect(agent.run({ prompt: 'Go' }))).rejects.toHaveProperty(
      'code',
      'MODEL_FAILURE',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
