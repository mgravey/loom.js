import {
  CODEX_AGENT_FACTORY,
  type CodexAgentEvent,
  type CodexAgentTool,
  type CodexModelEvent,
  type CodexModelRequest,
} from '@mgravey/loom-agent-codex';
import { createCancellationSource, type JsonObject } from '@mgravey/loom-types';
import { describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_MESSAGES_MODEL_CAPABILITY_ID,
  AnthropicMessagesModelError,
  createAnthropicMessagesModel,
  createAnthropicMessagesModelPlugin,
  createAnthropicMessagesRequestBody,
  parseRetryAfter,
  type AnthropicMessagesHttpResponse,
  type AnthropicMessagesModelOptions,
  type AnthropicMessagesRequest,
} from '../src/index.js';

const REQUEST: CodexModelRequest = {
  instructions: 'Edit carefully.',
  messages: [{ role: 'user', content: 'Read a.txt' }],
  tools: [
    {
      operation: 'workspace/read-file',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

function sse(...events: readonly unknown[]): string {
  return events
    .map((event) => {
      const type = (event as { type?: string }).type ?? 'unknown';
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
}

const start = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-opus-5-5',
    stop_reason: null,
    usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 3 },
  },
};
const textBlock = (index: number, ...parts: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...parts.map((text) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })),
  { type: 'content_block_stop', index },
];
const toolBlock = (index: number, id: string, name: string, ...json: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  ...json.map((partial_json) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json },
  })),
  { type: 'content_block_stop', index },
];
const stop = (reason: string, extra: Record<string, unknown> = {}) => [
  {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null, ...extra },
    usage: { output_tokens: 15 },
  },
  { type: 'message_stop' },
];

function transportReturning(
  ...responses: (Partial<AnthropicMessagesHttpResponse> | (() => AnthropicMessagesHttpResponse))[]
) {
  const requests: AnthropicMessagesRequest[] = [];
  const send = vi.fn((request: AnthropicMessagesRequest) => {
    requests.push(request);
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    const response =
      typeof next === 'function'
        ? next()
        : { status: 200, contentType: 'text/event-stream', body: '', ...next };
    return Promise.resolve(response);
  });
  return {
    transport: { send },
    requests,
    bodies: () => requests.map((r) => JSON.parse(r.body) as JsonObject),
  };
}

async function collect(
  options: Partial<AnthropicMessagesModelOptions> &
    Pick<AnthropicMessagesModelOptions, 'transport'>,
  request: CodexModelRequest = REQUEST,
  signal?: ReturnType<typeof createCancellationSource>['signal'],
): Promise<CodexModelEvent[]> {
  const model = createAnthropicMessagesModel({ model: 'claude-opus-5-5', ...options });
  const events: CodexModelEvent[] = [];
  for await (const event of model.generate(request, signal === undefined ? undefined : { signal }))
    events.push(event);
  return events;
}

function chunked(text: string, size: number): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < text.length; index += size) {
        await Promise.resolve();
        yield text.slice(index, index + size);
      }
    },
  };
}

describe('Anthropic Messages request body', () => {
  it('maps instructions, tools, limits, thinking, and effort without sampling parameters', () => {
    const body = createAnthropicMessagesRequestBody(REQUEST, 'claude-sonnet-5-5', {
      maxTokens: 4096,
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
      eagerInputStreaming: true,
    });
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      system: 'Edit carefully.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] }],
      tools: [
        {
          name: 'workspace_read-file',
          description: 'Read a file.',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          eager_input_streaming: true,
        },
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      stream: true,
    });
    const minimal = createAnthropicMessagesRequestBody(
      { instructions: ' ', messages: REQUEST.messages, tools: [] },
      'claude-haiku-5-5',
    );
    expect(minimal).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 32000,
      messages: REQUEST.messages.map(() => ({
        role: 'user',
        content: [{ type: 'text', text: 'Read a.txt' }],
      })),
      stream: true,
    });
    for (const field of ['temperature', 'top_p', 'top_k', 'tool_choice'])
      expect(body).not.toHaveProperty(field);
  });

  it('replays continuation blocks verbatim and groups tool results in one user message', () => {
    const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig-opaque' };
    const body = createAnthropicMessagesRequestBody(
      {
        ...REQUEST,
        messages: [
          { role: 'user', content: 'Do two things' },
          {
            role: 'assistant',
            content: 'Working',
            toolCalls: [
              { id: 'toolu_1', operation: 'workspace/read-file', input: { path: 'a' } },
              { id: 'toolu_2', operation: 'workspace/read-file', input: { path: 'b' } },
            ],
            continuationItems: [
              thinking,
              { type: 'text', text: 'Working' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'workspace_read-file',
                input: { path: 'a' },
              },
              {
                type: 'tool_use',
                id: 'toolu_2',
                name: 'workspace_read-file',
                input: { path: 'b' },
              },
            ],
          },
          {
            role: 'tool',
            callId: 'toolu_1',
            operation: 'workspace/read-file',
            result: { ok: true },
          },
          {
            role: 'tool',
            callId: 'toolu_2',
            operation: 'workspace/read-file',
            result: { ok: false, error: { code: 'TOOL_FAILURE' } },
          },
          { role: 'user', content: 'Thanks' },
        ],
      },
      'claude-opus-5-5',
    );
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Do two things' }] },
      {
        role: 'assistant',
        content: [
          thinking,
          { type: 'text', text: 'Working' },
          { type: 'tool_use', id: 'toolu_1', name: 'workspace_read-file', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'workspace_read-file', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: '{"ok":false,"error":{"code":"TOOL_FAILURE"}}',
            is_error: true,
          },
          { type: 'text', text: 'Thanks' },
        ],
      },
    ]);
  });

  it('rebuilds assistant turns from foreign continuations and keeps tool names stable', () => {
    const body = createAnthropicMessagesRequestBody(
      {
        instructions: 'x',
        tools: [
          { operation: 'website/run file', description: 'Run.', inputSchema: { type: 'object' } },
          { operation: 'website/run_file', description: 'Run 2.', inputSchema: { type: 'object' } },
        ],
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', operation: 'legacy/op', input: {} }],
            continuationItems: [{ type: 'function_call', name: 'loom_0_x' }],
          },
          { role: 'tool', callId: 'c1', operation: 'legacy/op', result: 'plain text' },
          { role: 'assistant', content: '', toolCalls: [] },
        ],
      },
      'm',
    );
    expect((body.tools as JsonObject[]).map((tool) => tool.name)).toEqual([
      'website_run_file',
      'website_run_file_2',
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'legacy_op', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'plain text' }],
      },
    ]);
  });

  it.each([
    [{ ...REQUEST, contextItems: [{ type: 'compaction' }] }, 'context items'],
    [{ ...REQUEST, tools: [...REQUEST.tools, ...REQUEST.tools] }, 'duplicate'],
    [{ ...REQUEST, messages: [] }, 'start with a user message'],
    [{ instructions: 1 } as unknown as CodexModelRequest, 'invalid agent request'],
  ] as const)('rejects invalid request %#', (request, message) => {
    expect(() => createAnthropicMessagesRequestBody(request, 'm')).toThrow(message);
  });
});

describe('Anthropic Messages streaming model', () => {
  it('streams text, parses streamed tool input, preserves thinking, and reports usage', async () => {
    const onUsage = vi.fn();
    const { transport, bodies } = transportReturning({
      body: chunked(
        sse(
          start,
          { type: 'ping' },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Need ' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'a file.' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig' },
          },
          { type: 'content_block_stop', index: 0 },
          ...textBlock(1, 'Reading ', 'now.'),
          ...toolBlock(2, 'toolu_1', 'workspace_read-file', '', '{"pa', 'th": "a.txt"}'),
          { type: 'future_event', detail: true },
          ...stop('tool_use'),
        ).replaceAll('\n', '\r\n'),
        7,
      ),
    });
    const events = await collect({ transport, onUsage, thinking: { type: 'adaptive' } });
    expect(events).toEqual([
      { type: 'text', text: 'Reading ' },
      { type: 'text', text: 'now.' },
      {
        type: 'continuation',
        item: { type: 'thinking', thinking: 'Need a file.', signature: 'sig' },
      },
      { type: 'continuation', item: { type: 'text', text: 'Reading now.' } },
      {
        type: 'continuation',
        item: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'workspace_read-file',
          input: { path: 'a.txt' },
        },
      },
      {
        type: 'tool-call',
        call: { id: 'toolu_1', operation: 'workspace/read-file', input: { path: 'a.txt' } },
      },
      { type: 'completed', final: true },
    ]);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 25,
      outputTokens: 15,
      cacheReadInputTokens: 3,
    });
    expect(bodies()[0]).toMatchObject({ thinking: { type: 'adaptive' }, stream: true });
  });

  it('accepts empty tool input, citations, and pause_turn continuation', async () => {
    const { transport } = transportReturning(() => ({
      status: 200,
      body: sse(
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'x' } },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'unknown_delta' } },
        { type: 'content_block_stop', index: 0 },
        ...toolBlock(1, 'toolu_2', 'workspace_read-file'),
        ...stop('pause_turn'),
      ),
    }));
    const events = await collect({
      transport,
      onUsage: () => {
        throw new Error('observer');
      },
    });
    expect(events).toContainEqual({
      type: 'continuation',
      item: { type: 'text', text: '', citations: [{ type: 'char_location', cited_text: 'x' }] },
    });
    expect(events).toContainEqual({
      type: 'tool-call',
      call: { id: 'toolu_2', operation: 'workspace/read-file', input: {} },
    });
    expect(events.at(-1)).toEqual({ type: 'completed', final: false });
  });

  it.each([
    ['max_tokens', 'INCOMPLETE_RESPONSE', { stopReason: 'max_tokens' }],
    ['model_context_window_exceeded', 'INCOMPLETE_RESPONSE', { contextCompactionRequired: true }],
    ['refusal', 'REFUSED', { refusalCategory: 'cyber' }],
  ] as const)('maps stop reason %s to %s without running tools', async (reason, code, fields) => {
    const { transport } = transportReturning({
      body: sse(
        start,
        ...toolBlock(0, 'toolu_9', 'workspace_read-file', '{}'),
        ...stop(reason, {
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'secret' },
        }),
      ),
    });
    const error = await collect({ transport }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnthropicMessagesModelError);
    expect(error).toMatchObject({ code, ...fields });
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it.each([
    ['overloaded_error', true, 'overloaded'],
    ['rate_limit_error', true, 'streaming failure'],
    ['invalid_request_error', false, 'streaming failure'],
    ['secret_unknown_type', false, 'streaming failure'],
  ] as const)('maps mid-stream %s errors', async (type, retryable, message) => {
    const { transport } = transportReturning({
      body: sse(start, ...textBlock(0, 'partial'), {
        type: 'error',
        error: { type, message: 'provider secret text' },
      }),
    });
    const error = await collect({ transport }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable,
      providerCode: type === 'secret_unknown_type' ? undefined : type,
    });
    expect((error as Error).message).toContain(message);
    expect(JSON.stringify(error)).not.toMatch(/secret/u);
  });

  it.each([
    ['missing message_stop', sse(start, ...textBlock(0, 'x'))],
    ['missing message_start', sse(...textBlock(0, 'x'), ...stop('end_turn'))],
    ['invalid JSON', `data: {not json\n\n`],
    ['invalid tool JSON', sse(start, ...toolBlock(0, 't', 'n', '{"a":'), ...stop('tool_use'))],
    ['array tool input', sse(start, ...toolBlock(0, 't', 'n', '[1]'), ...stop('tool_use'))],
    [
      'tool without id',
      sse(start, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name: 'n' },
      }),
    ],
    [
      'delta for unknown block',
      sse(start, {
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'text_delta', text: 'x' },
      }),
    ],
    [
      'open block',
      sse(
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...stop('end_turn'),
      ),
    ],
    ['duplicate start', sse(start, start)],
    ['bad index', sse(start, { type: 'content_block_stop', index: -1 })],
  ] as const)('rejects a malformed stream: %s', async (_name, body) => {
    const { transport } = transportReturning({ body });
    await expect(collect({ transport })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects non-SSE success responses and oversized events', async () => {
    const json = transportReturning({ body: '{"content":[]}', contentType: 'application/json' });
    await expect(collect({ transport: json.transport })).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
    const huge = transportReturning({ body: `data: "${'x'.repeat(1024 * 1024 + 10)}"\n\n` });
    await expect(collect({ transport: huge.transport })).rejects.toThrow('too large');
  });

  it.each([
    [429, 'rate_limit_error', 'HTTP_ERROR', true],
    [529, 'overloaded_error', 'HTTP_ERROR', true],
    [500, 'api_error', 'HTTP_ERROR', true],
    [401, 'authentication_error', 'AUTHENTICATION_FAILED', false],
    [403, 'permission_error', 'HTTP_ERROR', false],
    [402, 'billing_error', 'HTTP_ERROR', false],
    [400, 'invalid_request_error', 'HTTP_ERROR', false],
    [503, undefined, 'HTTP_ERROR', true],
  ] as const)('maps HTTP %i %s', async (status, type, code, retryable) => {
    const { transport } = transportReturning({
      status,
      contentType: 'application/json',
      requestId: 'req_011CSHoEeqs5C35K2UUqR7Fy',
      retryAfterMs: 2000,
      body: chunked(
        JSON.stringify({
          type: 'error',
          error: { type, message: 'sk-ant-secret in provider message' },
          request_id: 'req_body',
        }),
        5,
      ),
    });
    const error = await collect({ transport }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code,
      status,
      retryable,
      retryAfterMs: 2000,
      requestId: 'req_011CSHoEeqs5C35K2UUqR7Fy',
      providerCode: type,
      browserAccessDenied: false,
    });
    expect(JSON.stringify(error)).not.toContain('sk-ant-secret');
    expect(String(error)).not.toContain('sk-ant-secret');
  });

  it('flags organizations that refuse browser access and ignores unsafe metadata', async () => {
    const { transport } = transportReturning({
      status: 401,
      requestId: 'bad id with spaces',
      retryAfterMs: -5,
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'CORS requests are not allowed for this Organization because of its settings',
        },
      }),
    });
    const error = await collect({ transport }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      browserAccessDenied: true,
      retryable: false,
      requestId: undefined,
      retryAfterMs: undefined,
    });
    const tooLarge = transportReturning({
      status: 413,
      body: JSON.stringify({ error: { type: 'request_too_large' } }),
    });
    await expect(collect({ transport: tooLarge.transport })).rejects.toMatchObject({
      contextCompactionRequired: true,
    });
    for (const message of [
      'prompt is too long: 208310 tokens > 200000 maximum',
      'input length and `max_tokens` exceed context limit: 197202 + 21333 > 200000, decrease input length or `max_tokens` and try again',
    ]) {
      const tooLong = transportReturning({
        status: 400,
        body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
      });
      const compaction = await collect({ transport: tooLong.transport }).catch(
        (value: unknown) => value,
      );
      expect(compaction).toBeInstanceOf(AnthropicMessagesModelError);
      expect(compaction).toMatchObject({
        code: 'HTTP_ERROR',
        status: 400,
        providerCode: 'invalid_request_error',
        retryable: false,
        browserAccessDenied: false,
        contextCompactionRequired: true,
      });
      expect(String(compaction) + JSON.stringify(compaction)).not.toContain('tokens >');
    }
    for (const [status, type, message] of [
      [400, 'invalid_request_error', 'messages: field required'],
      [400, 'invalid_request_error', undefined],
      [429, 'rate_limit_error', 'prompt is too long: 1 tokens > 0 maximum'],
      [401, 'authentication_error', 'prompt is too long: 1 tokens > 0 maximum'],
    ] as const) {
      const other = transportReturning({
        status,
        body: JSON.stringify({ error: { type, message } }),
      });
      await expect(collect({ transport: other.transport })).rejects.toMatchObject({
        contextCompactionRequired: undefined,
      });
    }
    const oversized = transportReturning({ status: 400, body: `{"x":"${'y'.repeat(20_000)}"}` });
    await expect(collect({ transport: oversized.transport })).rejects.toMatchObject({
      providerCode: undefined,
    });
  });

  it('sanitizes transport failures and malformed transport responses', async () => {
    const failing = { send: vi.fn(() => Promise.reject(new Error('sk-ant-secret'))) };
    const error = await collect({ transport: failing }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(JSON.stringify(error) + String(error)).not.toContain('secret');
    const invalid = { send: vi.fn(() => Promise.resolve({ status: 'ok', body: 3 } as never)) };
    await expect(collect({ transport: invalid })).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    const stream = {
      send: vi.fn(() =>
        Promise.resolve({
          status: 200,
          body: {
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield sse(start);
              throw new Error('socket secret');
            },
          },
        }),
      ),
    };
    const interrupted = await collect({ transport: stream }).catch((value: unknown) => value);
    expect(interrupted).toMatchObject({ code: 'TRANSPORT_FAILED', retryable: true });
    expect(String(interrupted)).not.toContain('secret');
  });

  it('propagates cancellation to the transport and the stream', async () => {
    const source = createCancellationSource();
    let release: () => void = () => undefined;
    const transport = {
      send: vi.fn((request: AnthropicMessagesRequest) => {
        expect(request.signal).toBe(source.signal);
        return Promise.resolve({
          status: 200,
          body: {
            async *[Symbol.asyncIterator]() {
              yield sse(start);
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              yield sse(...stop('end_turn'));
            },
          },
        });
      }),
    };
    const running = collect({ transport }, REQUEST, source.signal);
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalled());
    source.cancel('stop');
    release();
    await expect(running).rejects.toMatchObject({ name: 'CancellationError' });
    const cancelled = createCancellationSource();
    cancelled.cancel();
    await expect(collect({ transport }, REQUEST, cancelled.signal)).rejects.toMatchObject({
      name: 'CancellationError',
    });
  });

  it.each([
    [{ model: '' }],
    [{ transport: {} }],
    [{ maxTokens: 0 }],
    [{ maxTokens: 1.5 }],
    [{ effort: 'extreme' }],
    [{ thinking: { type: 'enabled', budget_tokens: 1024 } }],
    [{ thinking: { type: 'disabled', display: 'omitted' } }],
    [{ thinking: { type: 'adaptive', display: 'verbose' } }],
    [{ eagerInputStreaming: 'yes' }],
    [{ onUsage: 1 }],
  ])('rejects invalid options %j', (overrides) => {
    expect(() =>
      createAnthropicMessagesModel({
        model: 'claude-opus-5-5',
        transport: { send: vi.fn() },
        ...(overrides as object),
      } as AnthropicMessagesModelOptions),
    ).toThrow(AnthropicMessagesModelError);
    expect(() => createAnthropicMessagesModel(null as never)).toThrow('options are required');
  });

  it('runs a complete tool-result continuation through the Loom agent', async () => {
    const { transport, bodies } = transportReturning(
      {
        body: sse(
          start,
          ...textBlock(0, 'Checking.'),
          ...toolBlock(1, 'toolu_a', 'website_echo', '{"value":"hi"}'),
          ...stop('tool_use'),
        ),
      },
      { body: sse(start, ...textBlock(0, 'Echoed hi.'), ...stop('end_turn')) },
    );
    const echo: CodexAgentTool = {
      name: 'echo',
      operation: 'website/echo',
      description: 'Echo a value.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      execute: (input: JsonObject) =>
        Promise.resolve({ echoed: (input as { value: string }).value }),
    } as unknown as CodexAgentTool;
    const agent = await CODEX_AGENT_FACTORY.create({
      model: createAnthropicMessagesModel({ model: 'claude-sonnet-5-5', transport }),
      tools: [echo],
      configuration: { maxTurns: 4, instructions: 'Use tools.' },
    });
    const events: CodexAgentEvent[] = [];
    for await (const event of agent.run({ prompt: 'Echo hi' })) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-finish', result: { echoed: 'hi' } }),
    );
    expect(events.at(-1)).toEqual({ type: 'completed', turns: 2 });
    const second = bodies()[1];
    expect(second?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Echo hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_a', name: 'website_echo', input: { value: 'hi' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '{"echoed":"hi"}' }],
      },
    ]);
    expect(second?.system).toBe('Use tools.');
  });

  it('registers as a Loom model plugin', () => {
    const plugin = createAnthropicMessagesModelPlugin({
      model: 'claude-haiku-5-5',
      transport: { send: vi.fn() },
    });
    expect(plugin.manifest.id).toBe('loom/model-anthropic-messages');
    expect(ANTHROPIC_MESSAGES_MODEL_CAPABILITY_ID).toBe('loom/anthropic-messages-model');
  });

  it('parses retry-after seconds and HTTP dates within bounds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('999999999')).toBeUndefined();
    const now = Date.parse('2026-11-20T10:00:00Z');
    expect(parseRetryAfter('Fri, 20 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Fri, 20 Nov 2026 09:00:00 GMT', now)).toBe(0);
  });
});
