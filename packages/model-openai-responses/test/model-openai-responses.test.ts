import type { CodexModelEvent, CodexModelRequest } from '@loom/agent-codex';
import { createCancellationSource } from '@loom/types';
import { describe, expect, it, vi } from 'vitest';

import {
  OPENAI_RESPONSES_ENDPOINT,
  OPENAI_RESPONSES_MODEL_CAPABILITY_ID,
  OpenAIResponsesModelError,
  createOpenAIResponsesModel,
  createOpenAIResponsesModelPlugin,
  createOpenAIResponsesRequestBody,
  decodeOpenAIResponses,
  type OpenAIResponsesHttpRequest,
  type OpenAIResponsesHttpResponse,
  type OpenAIResponsesRequest,
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
