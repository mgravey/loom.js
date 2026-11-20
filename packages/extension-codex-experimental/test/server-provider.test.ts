import { describe, expect, it } from 'vitest';
import { nativeRequest, nativeResponse, serverHeaders } from '../src/server-provider.js';
import { normalizeResponsesConnection, type ServerProvider } from '../src/responses-connections.js';
import { readModels, type ResponsesModelsFetch } from '../src/responses-models.js';

function connection(provider: ServerProvider) {
  return normalizeResponsesConnection({
    id: provider,
    label: provider,
    provider,
    endpoint: provider === 'gemini' ? 'https://example.com/v1beta/' : 'https://example.com/v1/',
    apiKey: 'secret-key',
  });
}
function request(input: unknown[], model = 'model-one') {
  return JSON.stringify({
    model,
    instructions: 'Help',
    input,
    tools: [
      {
        type: 'function',
        name: 'read',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
      },
    ],
    stream: true,
  });
}
const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] };
const anthropic = {
  type: 'message',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'opaque', signature: 'signature' },
    { type: 'tool_use', id: 'call-a', name: 'read', input: {} },
  ],
};
const gemini = {
  candidates: [
    {
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'read', args: {} }, thoughtSignature: 'signature' }],
      },
    },
  ],
};

describe('native server providers', () => {
  it.each(['anthropic', 'gemini'] as const)(
    'round trips %s tool calls and opaque signatures without duplicate actions',
    (provider) => {
      const profile = connection(provider);
      const output = JSON.parse(
        nativeResponse(
          provider,
          JSON.stringify(provider === 'anthropic' ? anthropic : gemini),
          'request-1',
        ),
      ).output as Record<string, unknown>[];
      const calls = output.filter((item) => item.type === 'function_call');
      expect(calls).toHaveLength(1);
      const result = nativeRequest(
        profile,
        request([
          user,
          ...output,
          { type: 'function_call_output', call_id: calls[0]?.call_id, output: '{"ok":true}' },
        ]),
      );
      const body = JSON.parse(result.body);
      expect(result.body).toContain('signature');
      expect(result.body).not.toContain('secret-key');
      if (provider === 'anthropic') {
        expect(result.endpoint).toBe('https://example.com/v1/messages');
        expect(body.messages[1].content).toEqual(anthropic.content);
        expect(body.messages[2].content).toEqual([
          { type: 'tool_result', tool_use_id: 'call-a', content: '{"ok":true}' },
        ]);
        expect(body.tools[0]).toHaveProperty('input_schema');
      } else {
        expect(result.endpoint).toBe('https://example.com/v1beta/models/model-one:generateContent');
        expect(body.contents[1].parts).toEqual(gemini.candidates[0]?.content.parts);
        expect(body.contents[2].parts).toEqual([
          { functionResponse: { name: 'read', response: { result: { ok: true } } } },
        ]);
        expect(body.tools[0].functionDeclarations[0]).toHaveProperty('parametersJsonSchema');
      }
      expect(serverHeaders(profile)).not.toHaveProperty('Authorization');
    },
  );
  it('rejects incomplete output, cross-provider continuations, missing/duplicate results and URL traversal', () => {
    expect(() =>
      nativeResponse('anthropic', JSON.stringify({ ...anthropic, stop_reason: 'max_tokens' }), 'r'),
    ).toThrow();
    expect(() =>
      nativeResponse('gemini', JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), 'r'),
    ).toThrow();
    const output = JSON.parse(nativeResponse('anthropic', JSON.stringify(anthropic), 'r'))
      .output as unknown[];
    expect(() => nativeRequest(connection('gemini'), request(output))).toThrow();
    expect(() => nativeRequest(connection('responses'), request(output))).toThrow();
    expect(() => nativeRequest(connection('anthropic'), request(output))).toThrow();
    const tool = { type: 'function_call_output', call_id: 'call-a', output: '{}' };
    expect(() =>
      nativeRequest(connection('anthropic'), request([...output, tool, tool])),
    ).toThrow();
    for (const model of ['../evil', '..', 'https://evil.example', 'model?key=x'])
      expect(() => nativeRequest(connection('gemini'), request([user], model))).toThrow();
  });
  it.each(['anthropic', 'gemini'] as const)(
    'returns %s final text in the portable envelope',
    (provider) => {
      const response =
        provider === 'anthropic'
          ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
          : {
              candidates: [
                { finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'done' }] } },
              ],
            };
      expect(
        JSON.parse(nativeResponse(provider, JSON.stringify(response), 'r')).output[0].content,
      ).toEqual([{ type: 'output_text', text: 'done' }]);
    },
  );
  it.each(['anthropic', 'gemini'] as const)(
    'discovers %s paginated models with isolated headers',
    async (provider) => {
      const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
      const fetch: ResponsesModelsFetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const page = calls.length;
        const body =
          provider === 'anthropic'
            ? { data: [{ id: `model-${String(page)}` }], has_more: page === 1, last_id: 'model-1' }
            : {
                models: [
                  {
                    name: `models/model-${String(page)}`,
                    supportedGenerationMethods: ['generateContent'],
                  },
                  { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
                ],
                ...(page === 1 ? { nextPageToken: 'next' } : {}),
              };
        return {
          status: 200,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
              c.close();
            },
          }),
        };
      };
      expect(await readModels(connection(provider), fetch)).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toContain(
        provider === 'anthropic' ? 'after_id=model-1' : 'pageToken=next',
      );
      expect(calls[0]?.headers[provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key']).toBe(
        'secret-key',
      );
      expect(calls[0]?.url).not.toContain('secret-key');
    },
  );
});
