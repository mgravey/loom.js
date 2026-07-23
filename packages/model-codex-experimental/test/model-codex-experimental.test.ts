import type { CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import { createCancellationSource } from '@mgravey/loom-types';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_EXPERIMENTAL_MODEL_CAPABILITY_ID,
  CodexExperimentalModelError,
  createCodexExperimentalModel,
  createCodexExperimentalModelPlugin,
  createCodexResponsesRequestBody,
  decodeCodexResponsesEvents,
  isRetryableProviderFailure,
  parseCodexResponsesSse,
  sanitizeCodexProviderMessage,
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
    expect(sent[0]).toMatchObject({ wireProtocol: 'classic' });
    const body = JSON.parse(sent[0]?.body ?? '') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'audited-model-id',
      instructions: 'Work carefully.',
      stream: true,
      store: false,
    });
    expect(JSON.stringify(body)).not.toContain('Bearer');
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the workspace.' }],
      },
      {
        type: 'message',
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
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });
    await expect(
      collect(parseCodexResponsesSse(chunks('event: custom\ndata: {"a":', '1}\n\n'))),
    ).resolves.toEqual([{ event: 'custom', data: '{"a":1}' }]);
  });

  it('uses the audited Responses Lite input-item envelope when requested', async () => {
    const body = createCodexResponsesRequestBody(REQUEST, 'gpt-5.6-sol', 'responses-lite');
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('tools');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'medium', context: 'all_turns' });
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'additional_tools', role: 'developer' }),
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Work carefully.' }],
        },
      ]),
    );

    const requests: CodexResponsesRequest[] = [];
    const model = createCodexExperimentalModel({
      model: 'gpt-5.6-sol',
      wireProtocol: 'responses-lite',
      transport: {
        async send(request) {
          requests.push(request);
          return response('data: {"type":"response.completed"}\n\n');
        },
      },
    });
    await collect(model.generate(REQUEST));
    expect(requests[0]?.wireProtocol).toBe('responses-lite');
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

  it('preserves sanitized structured failures from nested and top-level stream events', async () => {
    const topLevel = await collect(
      decodeCodexResponsesEvents(
        chunks(
          'data: {"type":"error","status":429,"code":"rate_limit_exceeded","message":"Rate limit reached\\nBearer top-secret-token"}\n\n',
        ),
      ),
    ).catch((error: unknown) => error);
    expect(topLevel).toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerMessage: 'Rate limit reached Bearer [REDACTED]',
      retryable: true,
    });
    expect(String((topLevel as CodexExperimentalModelError).providerMessage)).not.toContain(
      'top-secret-token',
    );

    await expect(
      collect(
        decodeCodexResponsesEvents(
          chunks(
            'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"Try again later."}}}\n\n',
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      providerCode: 'server_error',
      providerMessage: 'Try again later.',
      retryable: true,
    });

    await expect(
      collect(
        decodeCodexResponsesEvents(
          chunks(
            'data: {"type":"response.failed","status":429,"code":"insufficient_quota","message":"Add credit."}\n\n',
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      providerCode: 'insufficient_quota',
      providerMessage: 'Add credit.',
      retryable: false,
    });

    await expect(
      collect(
        decodeCodexResponsesEvents(
          chunks(
            'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      incompleteReason: 'max_output_tokens',
      retryable: false,
    });
    await expect(
      collect(
        decodeCodexResponsesEvents(
          chunks(
            'data: {"type":"response.incomplete","incomplete_details":{"reason":"content_filter"}}\n\n',
          ),
        ),
      ),
    ).rejects.toMatchObject({
      incompleteReason: 'content_filter',
      retryable: false,
    });
  });

  it('sanitizes provider messages and classifies only transient failures as retryable', () => {
    expect(
      sanitizeCodexProviderMessage(
        'Denied\u0000 api_key=private-key cookie=session-secret refresh_token=refresh-secret',
      ),
    ).toBe('Denied api_key=[REDACTED] cookie: [REDACTED]');
    expect(
      sanitizeCodexProviderMessage('Denied "api_key": "private key value" after validation.'),
    ).toBe('Denied "api_key": "[REDACTED]" after validation.');
    expect(sanitizeCodexProviderMessage({ raw: 'body' })).toBe(
      'The provider rejected the request.',
    );
    expect(isRetryableProviderFailure(408)).toBe(true);
    expect(isRetryableProviderFailure(503, 'server_error')).toBe(true);
    expect(isRetryableProviderFailure(429, 'insufficient_quota')).toBe(false);
    expect(isRetryableProviderFailure(503, 'billing_credit_rejected')).toBe(false);
    expect(isRetryableProviderFailure(503, 'authentication_failed')).toBe(false);
    expect(isRetryableProviderFailure(503, 'invalid_request_error')).toBe(false);
    expect(isRetryableProviderFailure(503, 'account_policy_restricted')).toBe(false);
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
      fetch: async () => ({
        status: 503,
        body: chunks('private provider detail'),
        providerCode: 'service_unavailable',
        providerMessage: 'Temporarily unavailable. Bearer private-token',
        retryable: true,
        retryAfterMs: 15_000,
      }),
    });
    await expect(collect(rejected.generate(REQUEST))).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 503,
      providerCode: 'service_unavailable',
      providerMessage: 'Temporarily unavailable. Bearer [REDACTED]',
      retryable: true,
      retryAfterMs: 15_000,
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
