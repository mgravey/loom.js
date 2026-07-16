import type { CodexModelEvent, CodexModelRequest } from '@loom/agent-codex';
import { createCancellationSource } from '@loom/types';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID,
  CodexExperimentalModelError,
  createCodexExperimentalModel,
  createCodexExperimentalModelPlugin,
  createCodexResponsesRequestBody,
  decodeCodexResponsesEvents,
  parseCodexResponsesSse,
  type CodexResponsesHttpRequest,
  type CodexResponsesHttpResponse,
  type CodexResponsesRequest,
} from '../src/index.js';

const REQUEST: CodexModelRequest = {
  instructions: 'Work carefully.',
  messages: [
    { role: 'user', content: 'Inspect the workspace.' },
    {
      role: 'assistant',
      content: 'I will inspect it.',
      toolCalls: [{ id: 'call-old', operation: 'workspace/list-files', input: { path: '.' } }],
    },
    {
      role: 'tool',
      callId: 'call-old',
      operation: 'workspace/list-files',
      result: { entries: [] },
    },
  ],
  tools: [
    {
      operation: 'workspace/read-file',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

async function* chunks(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function response(...values: string[]): CodexResponsesHttpResponse {
  return { status: 200, body: chunks(...values) };
}

const COMPLETE_STREAM = [
  ': keepalive\r\n\r\n',
  'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hello "}\r\n\r\n',
  'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"loom_0_workspace_read-file"}}\n\n',
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"path\\":"}\n\n',
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"README.md\\"}"}\n\n',
  'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"loom_0_workspace_read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n',
  'data: {"type":"response.completed"}\n\n',
  'data: [DONE]\n\n',
] as const;

describe('experimental Codex Responses model', () => {
  it('maps the agent protocol to a credential-free broker request and streams model events', async () => {
    const sent: CodexResponsesRequest[] = [];
    const model = createCodexExperimentalModel({
      model: 'audited-model-id',
      transport: {
        async send(request) {
          sent.push(request);
          return response(...COMPLETE_STREAM);
        },
      },
    });

    const events = await collect(model.generate(REQUEST));

    expect(events).toEqual<readonly CodexModelEvent[]>([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      {
        type: 'tool-call',
        call: { id: 'call-1', operation: 'workspace/read-file', input: { path: 'README.md' } },
      },
      { type: 'completed' },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('headers');
    expect(sent[0]).not.toHaveProperty('url');
    const body = JSON.parse(sent[0]?.body ?? '') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'audited-model-id',
      instructions: 'Work carefully.',
      stream: true,
      store: false,
    });
    expect(JSON.stringify(body)).not.toContain('Bearer');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Inspect the workspace.' }] },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
      },
      {
        type: 'function_call',
        call_id: 'call-old',
        name: 'loom_1_workspace_list-files',
        arguments: '{"path":"."}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-old',
        output: '{"entries":[]}',
      },
    ]);
  });

  it('supports explicit direct-fetch mode with injected authentication and account routing', async () => {
    const requests: CodexResponsesHttpRequest[] = [];
    const model = createCodexExperimentalModel({
      endpoint: 'https://provider.invalid/audited-responses',
      model: 'audited-model-id',
      authentication: { getAccessToken: async () => 'secret-access-token' },
      accountId: async () => 'account-1',
      originator: 'loom_test',
      headers: { 'X-Audit': 'yes' },
      async fetch(request) {
        requests.push(request);
        return response('data: {"type":"response.completed"}\n\n');
      },
    });

    await expect(collect(model.generate(REQUEST))).resolves.toEqual([{ type: 'completed' }]);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://provider.invalid/audited-responses',
      headers: {
        Authorization: 'Bearer secret-access-token',
        'ChatGPT-Account-ID': 'account-1',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        originator: 'loom_test',
        'X-Audit': 'yes',
      },
    });
  });

  it('exports deterministic request and chunk-safe SSE parsing helpers', async () => {
    expect(createCodexResponsesRequestBody(REQUEST, 'model-1')).toMatchObject({
      model: 'model-1',
      stream: true,
      store: false,
      tools: [{ type: 'function', name: 'loom_0_workspace_read-file', strict: false }],
    });
    await expect(
      collect(parseCodexResponsesSse(chunks('event: custom\ndata: {"a":', '1}\n\n'))),
    ).resolves.toEqual([{ event: 'custom', data: '{"a":1}' }]);
  });

  it('honors cancellation before authentication and while consuming the stream', async () => {
    const before = createCancellationSource();
    const auth = vi.fn(async () => 'token');
    before.cancel('stop');
    const direct = createCodexExperimentalModel({
      endpoint: 'unused',
      model: 'model',
      authentication: auth,
      fetch: async () => response(),
    });
    await expect(collect(direct.generate(REQUEST, { signal: before.signal }))).rejects.toThrow(
      'Operation cancelled',
    );
    expect(auth).not.toHaveBeenCalled();

    const during = createCancellationSource();
    const brokered = createCodexExperimentalModel({
      model: 'model',
      transport: {
        async send() {
          return {
            status: 200,
            body: (async function* () {
              yield 'data: {"type":"response.output_text.delta","delta":"one"}\n\n';
              during.cancel('stop');
              yield 'data: {"type":"response.completed"}\n\n';
            })(),
          };
        },
      },
    });
    await expect(collect(brokered.generate(REQUEST, { signal: during.signal }))).rejects.toThrow(
      'Operation cancelled',
    );
  });

  it('returns sanitized typed failures without leaking credentials or provider bodies', async () => {
    const authFailure = createCodexExperimentalModel({
      endpoint: 'https://secret.invalid',
      model: 'model',
      authentication: async () => {
        throw new Error('refresh_token=very-secret');
      },
      fetch: async () => response(),
    });
    const authError = await collect(authFailure.generate(REQUEST)).catch((error: unknown) => error);
    expect(authError).toBeInstanceOf(CodexExperimentalModelError);
    expect(authError).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String(authError)).not.toContain('very-secret');

    const rejected = createCodexExperimentalModel({
      model: 'model',
      transport: { send: async () => ({ status: 401, body: chunks('secret provider body') }) },
    });
    const httpError = await collect(rejected.generate(REQUEST)).catch((error: unknown) => error);
    expect(httpError).toMatchObject({ code: 'HTTP_ERROR', status: 401 });
    expect(String(httpError)).not.toContain('secret provider body');

    await expect(
      collect(
        decodeCodexResponsesEvents(
          chunks('data: {"type":"response.failed","response":{"error":"secret"}}\n\n'),
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(
      collect(decodeCodexResponsesEvents(chunks('data: not-json\n\n'), undefined)),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects invalid composition options at the provider-neutral boundary', () => {
    const invalidOptions: readonly unknown[] = [
      undefined,
      {},
      {
        model: 'model',
        transport: { send: async () => response() },
        fetch: async () => response(),
      },
      { model: 'model', transport: {} },
      { model: 'model', endpoint: 'endpoint', fetch: async () => response() },
      {
        model: 'model',
        endpoint: 'endpoint',
        authentication: async () => 'token',
        fetch: 'not-a-function',
      },
      {
        model: 'model',
        endpoint: '',
        authentication: async () => 'token',
        fetch: async () => response(),
      },
      {
        model: 'model',
        endpoint: 'endpoint',
        originator: '',
        authentication: async () => 'token',
        fetch: async () => response(),
      },
      {
        model: 'model',
        endpoint: 'endpoint',
        authentication: async () => 'token',
        fetch: async () => response(),
        headers: { '': 'value' },
      },
      {
        model: 'model',
        endpoint: 'endpoint',
        authentication: async () => 'token',
        fetch: async () => response(),
        headers: { 'Content-Type': 'application/json' },
      },
    ];
    for (const options of invalidOptions) {
      expect(() => createCodexExperimentalModel(options as never)).toThrow(
        CodexExperimentalModelError,
      );
    }
  });

  it('rejects malformed streams, calls, and transport results with typed errors', async () => {
    const malformedStreams = [
      'data: []\n\n',
      'data: {}\n\n',
      'data: {"type":"response.output_text.delta","delta":1}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","arguments":"{}"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call","name":"tool","arguments":"not-json"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call","name":"tool","arguments":"[]"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}\n\n',
      'data: {"type":"response.completed"}\n\ndata: {"type":"response.failed"}\n\n',
      '',
    ] as const;
    for (const stream of malformedStreams) {
      await expect(collect(decodeCodexResponsesEvents(chunks(stream)))).rejects.toBeInstanceOf(
        CodexExperimentalModelError,
      );
    }

    const invalidResponseModel = createCodexExperimentalModel({
      model: 'model',
      transport: {
        send: async () => null as unknown as CodexResponsesHttpResponse,
      },
    });
    await expect(collect(invalidResponseModel.generate(REQUEST))).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });

    const failingBody: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        throw new Error('private stream detail');
      },
    };
    await expect(collect(decodeCodexResponsesEvents(failingBody))).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
  });

  it('sanitizes invalid account routing and direct HTTP failures', async () => {
    const invalidAccount = createCodexExperimentalModel({
      model: 'model',
      endpoint: 'endpoint',
      authentication: async () => 'token',
      accountId: async () => '',
      fetch: async () => response(),
    });
    await expect(collect(invalidAccount.generate(REQUEST))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });

    const rejected = createCodexExperimentalModel({
      model: 'model',
      endpoint: 'endpoint',
      authentication: async () => 'token',
      fetch: async () => ({ status: 503, body: chunks('private provider detail') }),
    });
    await expect(collect(rejected.generate(REQUEST))).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 503,
    });
  });

  it('validates configuration and registers through public plugin APIs', () => {
    expect(() =>
      createCodexExperimentalModel({ model: '', transport: { send: async () => response() } }),
    ).toThrow('model must be a non-empty string');
    expect(() =>
      createCodexExperimentalModel({
        endpoint: 'endpoint',
        model: 'model',
        authentication: async () => 'token',
        fetch: async () => response(),
        headers: { Authorization: 'forbidden' },
      }),
    ).toThrow("header 'Authorization' is managed");

    const plugin = createCodexExperimentalModelPlugin({
      model: 'model',
      transport: { send: async () => response() },
    });
    const register = vi.fn();
    plugin.initialize?.({ capabilities: { register } } as never);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      kind: 'model',
      id: CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID,
    });
  });
});
