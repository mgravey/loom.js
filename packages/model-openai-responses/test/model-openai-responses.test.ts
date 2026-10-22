import type { CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import { createCancellationSource } from '@mgravey/loom-types';
import { describe, expect, it, vi } from 'vitest';

import {
  OPENAI_RESPONSES_ENDPOINT,
  OPENAI_COMPATIBLE_RESPONSES_MODEL_CAPABILITY_ID,
  OPENAI_RESPONSES_MODEL_CAPABILITY_ID,
  OpenAIResponsesModelError,
  createOpenAICompatibleResponsesModel,
  createOpenAICompatibleResponsesModelPlugin,
  createOpenAIResponsesModel,
  createOpenAIResponsesModelPlugin,
  createOpenAIResponsesRequestBody,
  decodeOpenAIResponses,
  type OpenAIResponsesHttpRequest,
  type OpenAIResponsesHttpResponse,
  type OpenAIResponsesRequest,
  type OpenAICompatibleResponsesHttpRequest,
} from '../src/index.js';

const CALLER = { type: 'program', caller_id: 'call-program-1' } as const;
const PROGRAM = {
  type: 'program',
  id: 'program-1',
  call_id: 'call-program-1',
  code: 'const files = await tools.list_files({}); text(JSON.stringify(files));',
  fingerprint: 'opaque-replay-state',
} as const;
const FUNCTION_CALL = {
  type: 'function_call',
  id: 'function-1',
  call_id: 'call-list-1',
  name: 'loom_0_workspace_list-files',
  arguments: '{}',
  caller: CALLER,
} as const;

const REQUEST: CodexModelRequest = {
  instructions: 'Inspect the workspace and make the requested change.',
  messages: [{ role: 'user', content: 'Inspect it.' }],
  tools: [
    {
      operation: 'workspace/list-files',
      description: 'List files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { entries: { type: 'array' } },
        required: ['entries'],
        additionalProperties: false,
      },
      allowedCallers: ['direct', 'programmatic'],
    },
    {
      operation: 'workspace/write-file',
      description: 'Write a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, created: { type: 'boolean' } },
        required: ['path', 'created'],
        additionalProperties: false,
      },
      allowedCallers: ['direct'],
    },
  ],
};

function response(body: unknown, status = 200): OpenAIResponsesHttpResponse {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

async function collect(
  values: AsyncIterable<CodexModelEvent>,
): Promise<readonly CodexModelEvent[]> {
  const events: CodexModelEvent[] = [];
  for await (const event of values) events.push(event);
  return events;
}

function chunks(...values: readonly string[]): AsyncIterable<string> {
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  });
}

describe('OpenAI Platform Responses model', () => {
  it('configures programmatic read tools and keeps writes direct-only', () => {
    const body = createOpenAIResponsesRequestBody(REQUEST, 'gpt-5.6');

    expect(body).toMatchObject({
      model: 'gpt-5.6',
      store: false,
      stream: false,
      parallel_tool_calls: true,
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
      include: ['reasoning.encrypted_content'],
    });
    expect(body.instructions).toContain('Never invoke a write from a');
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'loom_0_workspace_list-files',
        allowed_callers: ['direct', 'programmatic'],
        output_schema: REQUEST.tools[0]?.outputSchema,
      }),
      expect.objectContaining({
        type: 'function',
        name: 'loom_1_workspace_write-file',
        allowed_callers: ['direct'],
        output_schema: REQUEST.tools[1]?.outputSchema,
      }),
      { type: 'programmatic_tool_calling' },
    ]);
  });

  it('can disable hosted programs while preserving ordinary transcript calls', () => {
    const directRequest: CodexModelRequest = {
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [
            { id: 'old-call', operation: 'workspace/list-files', input: { path: 'src' } },
          ],
        },
      ],
    };
    const body = createOpenAIResponsesRequestBody(directRequest, 'gpt-5.6', {
      programmaticToolCalling: false,
      reasoningEffort: 'high',
      textVerbosity: 'high',
    });

    expect(body.instructions).toBe(REQUEST.instructions);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.text).toEqual({ verbosity: 'high' });
    expect(body.tools).not.toContainEqual({ type: 'programmatic_tool_calling' });
    expect(body.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ allowed_callers: ['direct'] })]),
    );
    expect(body.input).toEqual(
      expect.arrayContaining([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect it.' }],
        },
        {
          type: 'function_call',
          call_id: 'old-call',
          name: 'loom_0_workspace_list-files',
          arguments: '{"path":"src"}',
        },
      ]),
    );
  });

  it('preserves every response item and caller while exposing normalized tool events', async () => {
    const sent: OpenAIResponsesRequest[] = [];
    const model = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      transport: {
        async send(request) {
          sent.push(request);
          return response({ status: 'completed', output: [PROGRAM, FUNCTION_CALL] });
        },
      },
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual([
      { type: 'continuation', item: PROGRAM },
      { type: 'continuation', item: FUNCTION_CALL },
      {
        type: 'tool-call',
        call: {
          id: 'call-list-1',
          operation: 'workspace/list-files',
          input: {},
          caller: CALLER,
        },
      },
      { type: 'completed', final: false },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('url');
    expect(sent[0]).not.toHaveProperty('headers');
    expect(JSON.stringify(sent[0])).not.toContain('Bearer');
  });

  it('replays stateless output items and copies caller onto function results', () => {
    const continued: CodexModelRequest = {
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-list-1',
              operation: 'workspace/list-files',
              input: {},
              caller: CALLER,
            },
          ],
          continuationItems: [PROGRAM, FUNCTION_CALL],
        },
        {
          role: 'tool',
          callId: 'call-list-1',
          operation: 'workspace/list-files',
          result: { entries: [] },
          caller: CALLER,
        },
      ],
    };

    const body = createOpenAIResponsesRequestBody(continued, 'gpt-5.6');
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect it.' }],
      },
      PROGRAM,
      FUNCTION_CALL,
      {
        type: 'function_call_output',
        call_id: 'call-list-1',
        output: '{"entries":[]}',
        caller: CALLER,
      },
    ]);
  });

  it('stops only when a final assistant message is present', async () => {
    const programOutput = {
      type: 'program_output',
      id: 'program-output-1',
      call_id: 'call-program-1',
      result: '{"entries":[]}',
      status: 'completed',
    } as const;
    await expect(
      collect(
        decodeOpenAIResponses(
          JSON.stringify({ status: 'completed', output: [programOutput] }),
          REQUEST,
        ),
      ),
    ).resolves.toEqual([
      { type: 'continuation', item: programOutput },
      { type: 'completed', final: false },
    ]);

    const message = {
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    } as const;
    await expect(
      collect(
        decodeOpenAIResponses(
          JSON.stringify({ status: 'completed', output: [programOutput, message] }),
          REQUEST,
        ),
      ),
    ).resolves.toEqual([
      { type: 'continuation', item: programOutput },
      { type: 'continuation', item: message },
      { type: 'text', text: 'Done.' },
      { type: 'completed', final: true },
    ]);
  });

  it('supports trusted-host direct mode without exposing provider failures', async () => {
    const requests: OpenAIResponsesHttpRequest[] = [];
    const model = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      authentication: async () => 'secret-api-key',
      headers: { 'X-Trace': 'safe' },
      async fetch(request) {
        requests.push(request);
        return response({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done.' }],
            },
          ],
        });
      },
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual(
      expect.arrayContaining([{ type: 'text', text: 'Done.' }]),
    );
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: OPENAI_RESPONSES_ENDPOINT,
      headers: {
        Authorization: 'Bearer secret-api-key',
        'Content-Type': 'application/json',
        'X-Trace': 'safe',
      },
    });

    const rejected = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      transport: {
        send: async () => response('provider body containing a secret', 401),
      },
    });
    const error = await collect(rejected.generate(REQUEST)).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'HTTP_ERROR', status: 401 });
    expect(String(error)).not.toContain('provider body');
  });

  it('rejects incomplete, malformed, cancelled, and invalid configurations', async () => {
    await expect(
      collect(decodeOpenAIResponses(JSON.stringify({ status: 'incomplete', output: [] }), REQUEST)),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RESPONSE' });
    await expect(collect(decodeOpenAIResponses('not-json', REQUEST))).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
    expect(() =>
      createOpenAIResponsesModel({
        model: 'gpt-5.6',
        authentication: async () => 'key',
        fetch: async () => response({ status: 'completed', output: [] }),
        headers: { Authorization: 'forbidden' },
      }),
    ).toThrow(OpenAIResponsesModelError);

    const cancellation = createCancellationSource();
    const send = vi.fn(async () => response({ status: 'completed', output: [] }));
    cancellation.cancel('stop');
    const model = createOpenAIResponsesModel({ model: 'gpt-5.6', transport: { send } });
    await expect(collect(model.generate(REQUEST, { signal: cancellation.signal }))).rejects.toThrow(
      'Operation cancelled',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('validates every configuration and transport boundary with sanitized errors', async () => {
    const success = async () => response({ status: 'completed', output: [] });
    const invalidOptions: readonly unknown[] = [
      undefined,
      {},
      { model: '', transport: { send: success } },
      { model: 'gpt-5.6', transport: { send: success }, fetch: success },
      { model: 'gpt-5.6', transport: {} },
      { model: 'gpt-5.6', transport: { send: success }, reasoningEffort: 'extreme' },
      { model: 'gpt-5.6', transport: { send: success }, textVerbosity: 'verbose' },
      { model: 'gpt-5.6', transport: { send: success }, programmaticToolCalling: 'yes' },
      { model: 'gpt-5.6', fetch: success },
      {
        model: 'gpt-5.6',
        authentication: async () => 'key',
        fetch: success,
        headers: { '': 'value' },
      },
      {
        model: 'gpt-5.6',
        authentication: async () => 'key',
        fetch: success,
        headers: { 'X-Trace': '' },
      },
    ];
    for (const options of invalidOptions) {
      expect(() => createOpenAIResponsesModel(options as never)).toThrow(OpenAIResponsesModelError);
    }

    expect(() => createOpenAIResponsesRequestBody(null as never, 'gpt-5.6')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    const firstTool = REQUEST.tools[0];
    if (firstTool === undefined) throw new Error('Test fixture is missing its first tool.');
    expect(() =>
      createOpenAIResponsesRequestBody(
        { ...REQUEST, tools: [...REQUEST.tools, firstTool] },
        'gpt-5.6',
      ),
    ).toThrow(/duplicate tool operation/iu);

    const invalidTransport = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      transport: { send: async () => null as unknown as OpenAIResponsesHttpResponse },
    });
    await expect(collect(invalidTransport.generate(REQUEST))).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    const throwingTransport = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      transport: {
        send: async () => {
          throw new Error('private transport detail');
        },
      },
    });
    const transportError = await collect(throwingTransport.generate(REQUEST)).catch(
      (value: unknown) => value,
    );
    expect(transportError).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(String(transportError)).not.toContain('private transport detail');

    const invalidKey = createOpenAIResponsesModel({
      model: 'gpt-5.6',
      authentication: { getAccessToken: async () => '' },
      fetch: success,
    });
    await expect(collect(invalidKey.generate(REQUEST))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('rejects malformed response items and provider terminal states', async () => {
    const malformedBodies = [
      JSON.stringify({ status: 'failed', output: [] }),
      JSON.stringify({ status: 'completed' }),
      JSON.stringify({ status: 'completed', output: [null] }),
      JSON.stringify({ status: 'completed', output: [{ type: 'message' }] }),
      JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [null] }] }),
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 1 }] }],
      }),
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 1 }] }],
      }),
      JSON.stringify({ status: 'completed', output: [{ type: 'function_call' }] }),
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call',
            name: 'loom_0_workspace_list-files',
            arguments: 'not-json',
          },
        ],
      }),
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call',
            name: 'loom_0_workspace_list-files',
            arguments: '[]',
          },
        ],
      }),
    ];
    for (const body of malformedBodies) {
      await expect(collect(decodeOpenAIResponses(body, REQUEST))).rejects.toBeInstanceOf(
        OpenAIResponsesModelError,
      );
    }

    const refusal = {
      type: 'message',
      content: [{ type: 'refusal', refusal: 'Cannot comply.' }],
    };
    await expect(
      collect(
        decodeOpenAIResponses(JSON.stringify({ status: 'completed', output: [refusal] }), REQUEST),
      ),
    ).resolves.toEqual([
      { type: 'continuation', item: refusal },
      { type: 'text', text: 'Cannot comply.' },
      { type: 'completed', final: true },
    ]);
  });

  it('registers a separate typed model capability', async () => {
    const register = vi.fn();
    const plugin = createOpenAIResponsesModelPlugin({
      model: 'gpt-5.6',
      transport: { send: async () => response({ status: 'completed', output: [] }) },
    });
    await plugin.initialize?.({ capabilities: { register } } as never);

    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      kind: 'model',
      id: OPENAI_RESPONSES_MODEL_CAPABILITY_ID,
    });
  });
});

describe('OpenAI-compatible Responses model', () => {
  it('emits the portable request subset and supports an unauthenticated JSON fallback', async () => {
    const requests: OpenAICompatibleResponsesHttpRequest[] = [];
    const model = createOpenAICompatibleResponsesModel({
      model: 'qwen3:8b',
      endpoint: 'http://localhost:11434/v1/responses',
      async fetch(request) {
        requests.push(request);
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Local answer.' }],
              },
            ],
          }),
        };
      },
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual(
      expect.arrayContaining([{ type: 'text', text: 'Local answer.' }]),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(requests[0]?.body ?? '{}') as Readonly<Record<string, unknown>>;
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      instructions: REQUEST.instructions,
      stream: true,
    });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('text');
    expect(body).not.toHaveProperty('include');
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          name: 'loom_0_workspace_list-files',
          parameters: REQUEST.tools[0]?.inputSchema,
        }),
      ]),
    );
    expect(JSON.stringify(body.tools)).not.toContain('allowed_callers');
    expect(JSON.stringify(body.tools)).not.toContain('output_schema');
    expect(JSON.stringify(body.tools)).not.toContain('programmatic_tool_calling');
  });

  it('streams text and reconstructs a split function call', async () => {
    const model = createOpenAICompatibleResponsesModel({
      model: 'local-tools',
      endpoint: 'http://localhost:1234/v1/responses',
      authentication: async () => 'local-secret',
      fetch: async (request) => {
        expect(request.headers.Authorization).toBe('Bearer local-secret');
        return {
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          body: chunks(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel',
            'lo "}\n\ndata: {"type":"response.output_text.delta","delta":"there"}\n\n',
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"loom_0_workspace_list-files","arguments":""}}\n\n',
            'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":"}\n\n',
            'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"path\\":\\"src\\"}"}\n\n',
            'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"loom_0_workspace_list-files","arguments":"{\\"path\\":\\"src\\"}"}}\n\n',
            'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
          ),
        };
      },
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
      {
        type: 'continuation',
        item: {
          type: 'function_call',
          id: 'item-1',
          call_id: 'call-1',
          name: 'loom_0_workspace_list-files',
          arguments: '{"path":"src"}',
        },
      },
      {
        type: 'tool-call',
        call: {
          id: 'call-1',
          operation: 'workspace/list-files',
          input: { path: 'src' },
        },
      },
      { type: 'completed', final: false },
    ]);
  });

  it('accepts a complete output on the terminal event without duplicating streamed text', async () => {
    const message = {
      type: 'message',
      id: 'message-local',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done.' }],
    } as const;
    const model = createOpenAICompatibleResponsesModel({
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
      fetch: async () => ({
        status: 200,
        body: chunks(
          'data: {"type":"response.output_text.delta","delta":"Done."}\n\n',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output: [message] },
          })}\n\n`,
        ),
      }),
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual([
      { type: 'text', text: 'Done.' },
      { type: 'continuation', item: message },
      { type: 'completed', final: true },
    ]);
  });

  it('sanitizes authentication, transport, HTTP, malformed, incomplete, and oversized failures', async () => {
    const options = {
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
    } as const;
    const invalidKey = createOpenAICompatibleResponsesModel({
      ...options,
      authentication: async () => '',
      fetch: async () => ({ status: 200, body: '{}' }),
    });
    await expect(collect(invalidKey.generate(REQUEST))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });

    const transport = createOpenAICompatibleResponsesModel({
      ...options,
      fetch: async () => {
        throw new Error('private transport details');
      },
    });
    const transportError = await collect(transport.generate(REQUEST)).catch(
      (error: unknown) => error,
    );
    expect(transportError).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(String(transportError)).not.toContain('private transport details');

    for (const fixture of [
      { status: 401, body: 'secret rejection' },
      { status: 200, body: 'data: not-json\n\n' },
      { status: 200, body: 'data: {"type":"response.incomplete"}\n\n' },
      { status: 200, body: `data: ${'x'.repeat(1024 * 1024 + 1)}\n\n` },
    ]) {
      const model = createOpenAICompatibleResponsesModel({
        ...options,
        fetch: async () => ({ ...fixture, contentType: 'text/event-stream' }),
      });
      await expect(collect(model.generate(REQUEST))).rejects.toBeInstanceOf(
        OpenAIResponsesModelError,
      );
    }
  });

  it('validates compatible configuration, cancellation, and plugin registration', async () => {
    const validFetch = async () => ({ status: 200, body: '{}' });
    for (const invalid of [
      undefined,
      {},
      { model: '', endpoint: 'http://localhost/v1/responses', fetch: validFetch },
      { model: 'local', endpoint: '', fetch: validFetch },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        stream: 'yes',
      },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        authentication: {},
      },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        headers: { '': 'value' },
      },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        headers: { 'X-Trace': '' },
      },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        headers: { Authorization: 'forbidden' },
      },
      {
        model: 'local',
        endpoint: 'http://localhost/v1/responses',
        fetch: validFetch,
        headers: { 'Content-Type': 'forbidden' },
      },
    ]) {
      expect(() => createOpenAICompatibleResponsesModel(invalid as never)).toThrow(
        OpenAIResponsesModelError,
      );
    }

    const cancellation = createCancellationSource();
    const fetch = vi.fn(async () => ({ status: 200, body: '{}' }));
    cancellation.cancel('stop');
    const model = createOpenAICompatibleResponsesModel({
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
      fetch,
    });
    await expect(collect(model.generate(REQUEST, { signal: cancellation.signal }))).rejects.toThrow(
      'Operation cancelled',
    );
    expect(fetch).not.toHaveBeenCalled();

    const register = vi.fn();
    const plugin = createOpenAICompatibleResponsesModelPlugin({
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
      fetch: async () => ({ status: 200, body: '{}' }),
    });
    await plugin.initialize?.({ capabilities: { register } } as never);
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      kind: 'model',
      id: OPENAI_COMPATIBLE_RESPONSES_MODEL_CAPABILITY_ID,
    });
  });

  it('handles compatible SSE framing variants and iterable JSON bodies', async () => {
    const message = {
      type: 'message',
      id: 'message-framed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Framed response.' }],
    } as const;
    const framed = createOpenAICompatibleResponsesModel({
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
      stream: false,
      fetch: async (request) => {
        expect(JSON.parse(request.body)).toMatchObject({ stream: false });
        return {
          status: 200,
          body:
            ': keepalive\r\nevent: response.output_item.done\r\n' +
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              item_id: 'message-framed',
              item: message,
            })}\r\n\r\n` +
            'data: [DONE]',
        };
      },
    });
    await expect(collect(framed.generate(REQUEST))).resolves.toEqual([
      { type: 'continuation', item: message },
      { type: 'text', text: 'Framed response.' },
      { type: 'completed', final: true },
    ]);

    const json = JSON.stringify({ status: 'completed', output: [message] });
    const iterableJson = createOpenAICompatibleResponsesModel({
      model: 'local',
      endpoint: 'http://localhost/v1/responses',
      fetch: async () => ({
        status: 200,
        contentType: 'application/json',
        body: chunks(json.slice(0, 20), json.slice(20)),
      }),
    });
    await expect(collect(iterableJson.generate(REQUEST))).resolves.toEqual([
      { type: 'continuation', item: message },
      { type: 'text', text: 'Framed response.' },
      { type: 'completed', final: true },
    ]);
  });

  it('rejects invalid transport envelopes and non-terminal or failed streams', async () => {
    const base = { model: 'local', endpoint: 'http://localhost/v1/responses' } as const;
    for (const responseValue of [
      null,
      { status: '200', body: '{}' },
      { status: 200, body: [] },
      { status: 200, body: '{}', contentType: 1 },
    ]) {
      const model = createOpenAICompatibleResponsesModel({
        ...base,
        fetch: async () => responseValue as never,
      });
      await expect(collect(model.generate(REQUEST))).rejects.toMatchObject({
        code: 'TRANSPORT_FAILED',
      });
    }

    for (const body of [
      'data: {"type":"response.failed"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      'data: {"type":"response.output_text.delta","delta":1}\n\n',
      'data: {"type":"response.output_item.done","item":null}\n\n',
    ]) {
      const model = createOpenAICompatibleResponsesModel({
        ...base,
        fetch: async () => ({ status: 200, contentType: 'text/event-stream', body }),
      });
      await expect(collect(model.generate(REQUEST))).rejects.toBeInstanceOf(
        OpenAIResponsesModelError,
      );
    }
  });
});

describe('compatible brokered transport', () => {
  it('generates through an injected transport without a URL or key supplier', async () => {
    const send = vi.fn<
      (request: { body: string }) => Promise<{ status: number; contentType: string; body: string }>
    >(async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Brokered answer.' }],
          },
        ],
      }),
    }));
    const model = createOpenAICompatibleResponsesModel({ model: 'local', transport: { send } });
    const events = await collect(model.generate(REQUEST));
    expect(events).toContainEqual({ type: 'text', text: 'Brokered answer.' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('url');
    for (const extra of [
      { endpoint: 'https://evil.example/v1/responses' },
      { authentication: { getApiKey: () => 'key' } },
      { headers: {} },
      { fetch: vi.fn() },
    ]) {
      expect(() =>
        createOpenAICompatibleResponsesModel({
          model: 'local',
          transport: { send },
          ...extra,
        } as never),
      ).toThrow(OpenAIResponsesModelError);
    }
  });
});

it('does not duplicate a tool when the terminal snapshot uses output indices and handles split CRLF', async () => {
  const item = {
    type: 'function_call',
    id: 'function-1',
    call_id: 'call-list-1',
    name: 'loom_0_workspace_list-files',
    arguments: '{}',
  };
  const wire =
    `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\r\n\r\n` +
    `data: ${JSON.stringify({ type: 'response.completed', response: { output: [item] } })}\r\n\r\n`;
  const model = createOpenAICompatibleResponsesModel({
    model: 'local',
    transport: {
      send: async () => ({
        status: 200,
        contentType: 'text/event-stream',
        body: chunks(...wire.split('')),
      }),
    },
  });
  const events = await collect(model.generate(REQUEST));
  expect(events.filter((event) => event.type === 'tool-call')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'continuation')).toHaveLength(1);
});
