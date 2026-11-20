import { GOOGLE_SUBSCRIPTION_ENDPOINT } from './google-subscription.js';
import type { ResponsesConnection, ServerProvider } from './responses-connections.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid provider data.');
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Invalid provider string.');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid provider list.');
  return value;
}
export function serverHeaders(connection: ResponsesConnection): Record<string, string> {
  const key = connection.apiKey;
  switch (connection.provider) {
    case 'anthropic':
      return {
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(key === '' ? {} : { 'x-api-key': key }),
      };
    case 'gemini':
      return key === '' ? {} : { 'x-goog-api-key': key };
    default:
      return key === '' ? {} : { Authorization: `Bearer ${key}` };
  }
}
export function serverBaseUrl(connection: ResponsesConnection): string {
  return connection.endpoint.replace(/(?:responses|messages)$/u, '');
}

/** Convert the portable wire envelope only inside the trusted extension. Never execute tools here. */
export function nativeRequest(
  connection: ResponsesConnection,
  source: string,
): { endpoint: string; body: string } {
  const provider = connection.provider ?? 'responses';
  if (provider === 'gemini-subscription') {
    if (
      !connection.projectId ||
      !connection.subscriptionModels?.includes(string(record(JSON.parse(source)).model))
    )
      throw new Error('Select a configured subscription model.');
    const adapted = nativeRequest(
      {
        ...connection,
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/',
      },
      source,
    );
    return {
      endpoint: GOOGLE_SUBSCRIPTION_ENDPOINT,
      body: JSON.stringify({
        model: record(JSON.parse(source)).model,
        project: connection.projectId,
        request: JSON.parse(adapted.body) as unknown,
      }),
    };
  }
  if (provider === 'responses' || provider === 'claude-code') {
    // Native signatures cannot be transplanted to a different provider.
    if (
      array(record(JSON.parse(source)).input).some(
        (item) => record(item).loom_provider !== undefined,
      )
    )
      throw new Error('Start a new conversation when changing providers.');
    return { endpoint: connection.endpoint, body: source };
  }
  const body = record(JSON.parse(source));
  const model = string(body.model);
  const messages: { role: string; content: RecordValue[] }[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  const completed = new Set<string>();
  const append = (role: string, content: RecordValue): void => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(content);
    else messages.push({ role, content: [content] });
  };
  for (const raw of array(body.input)) {
    const item = record(raw);
    if (item.loom_provider !== undefined) {
      if (item.loom_provider !== provider) throw new Error('Incompatible provider continuation.');
      const native = record(item.loom_native);
      if (item.type === 'function_call') {
        const call = provider === 'gemini' ? record(native.functionCall) : native;
        const id = string(item.call_id);
        if (calls.has(id)) throw new Error('Duplicate tool call.');
        calls.set(id, {
          name: string(call.name),
          ...(typeof call.id === 'string' ? { id: call.id } : {}),
        });
      }
      append('assistant', native);
    } else if (item.type === 'message' || item.type === undefined) {
      const role = string(item.role);
      if (!['user', 'assistant'].includes(role)) throw new Error('Unsupported message role.');
      const parts =
        typeof item.content === 'string'
          ? [{ text: item.content }]
          : array(item.content).map((part) => {
              const value = record(part);
              if (!['input_text', 'output_text'].includes(String(value.type)))
                throw new Error('Unsupported message content.');
              return { text: string(value.text) };
            });
      for (const part of parts)
        append(role, provider === 'anthropic' ? { type: 'text', ...part } : part);
    } else if (item.type === 'function_call') {
      const id = string(item.call_id),
        name = string(item.name);
      if (calls.has(id)) throw new Error('Duplicate tool call.');
      const args = record(JSON.parse(string(item.arguments)));
      calls.set(id, { name, id });
      append(
        'assistant',
        provider === 'anthropic'
          ? { type: 'tool_use', id, name, input: args }
          : { functionCall: { name, args, id } },
      );
    } else if (item.type === 'function_call_output') {
      const id = string(item.call_id),
        call = calls.get(id);
      if (!call || completed.has(id)) throw new Error('Unpaired tool result.');
      completed.add(id);
      if (provider === 'anthropic')
        append('user', { type: 'tool_result', tool_use_id: id, content: string(item.output) });
      else
        append('user', {
          functionResponse: {
            name: call.name,
            ...(call.id === undefined ? {} : { id: call.id }),
            response: { result: JSON.parse(string(item.output)) as unknown },
          },
        });
    } else throw new Error('Unsupported continuation item.');
  }
  if ([...calls.keys()].some((id) => !completed.has(id))) throw new Error('Missing tool result.');
  const tools = array(body.tools).map((raw) => {
    const tool = record(raw);
    const name = string(tool.name),
      description = typeof tool.description === 'string' ? tool.description : '';
    const schema = record(tool.parameters);
    return provider === 'anthropic'
      ? { name, description, input_schema: schema }
      : { name, description, parametersJsonSchema: schema };
  });
  if (provider === 'anthropic')
    return {
      endpoint: connection.endpoint,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        stream: false,
        system: body.instructions,
        messages,
        ...(tools.length ? { tools } : {}),
      }),
    };
  const modelId = model.replace(/^models\//u, '');
  if (!/^[a-zA-Z0-9._-]+$/u.test(modelId) || modelId === '.' || modelId === '..')
    throw new Error('Invalid Gemini model ID.');
  return {
    endpoint: `${connection.endpoint}models/${encodeURIComponent(modelId)}:generateContent`,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: body.instructions }] },
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: message.content,
      })),
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    }),
  };
}

/** Preserve each native block (including opaque signatures) alongside its portable representation. */
export function nativeResponse(
  provider: Exclude<ServerProvider, 'responses'>,
  source: string,
  requestId: string,
): string {
  if (provider === 'gemini-subscription') {
    const wrapper = record(JSON.parse(source));
    return nativeResponse('gemini', JSON.stringify(record(wrapper.response)), requestId);
  }
  const value = record(JSON.parse(source));
  let parts: unknown[];
  if (provider === 'anthropic') {
    if (
      value.type !== 'message' ||
      !['end_turn', 'tool_use', 'stop_sequence'].includes(String(value.stop_reason))
    )
      throw new Error('Incomplete or invalid Anthropic response.');
    parts = array(value.content);
  } else {
    const candidates = array(value.candidates);
    if (candidates.length !== 1) throw new Error('Invalid Gemini candidates.');
    const candidate = record(candidates[0]);
    if (candidate.finishReason !== 'STOP')
      throw new Error('Incomplete or blocked Gemini response.');
    const content = record(candidate.content);
    if (content.role !== 'model') throw new Error('Invalid Gemini role.');
    parts = array(content.parts);
  }
  const ids = new Set<string>();
  const output = parts.map((raw, index) => {
    const part = record(raw);
    const opaque = { loom_provider: provider, loom_native: part };
    const call =
      provider === 'anthropic' ? (part.type === 'tool_use' ? part : undefined) : part.functionCall;
    if (call !== undefined) {
      const tool = record(call);
      const id = typeof tool.id === 'string' ? string(tool.id) : `${requestId}_${String(index)}`;
      if (ids.has(id)) throw new Error('Duplicate provider tool call.');
      ids.add(id);
      return {
        type: 'function_call',
        call_id: id,
        name: string(tool.name),
        arguments: JSON.stringify(record(provider === 'anthropic' ? tool.input : tool.args)),
        ...opaque,
      };
    }
    if (
      (provider === 'anthropic' && part.type === 'text') ||
      (provider === 'gemini' && typeof part.text === 'string' && part.thought !== true)
    )
      return {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: typeof part.text === 'string' ? part.text : string(part.text),
          },
        ],
        ...opaque,
      };
    if (
      (provider === 'anthropic' && ['thinking', 'redacted_thinking'].includes(String(part.type))) ||
      (provider === 'gemini' &&
        (part.thought === true || typeof part.thoughtSignature === 'string'))
    )
      return { type: 'reasoning', ...opaque };
    throw new Error('Unsupported provider output.');
  });
  if (!output.length) throw new Error('Empty provider response.');
  return JSON.stringify({ status: 'completed', output });
}
