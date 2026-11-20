import { OpenAIResponsesModelError } from '@mgravey/loom-model-openai-responses';

import { chatgptError, providerError } from './errors.js';
import { providerCodeFrom, record } from './http.js';

const MAX_EVENT = 1024 * 1024;
const MAX_STREAM = 8 * 1024 * 1024;
/** Request fields documented as accepted on the plan-usage route and emitted by Loom. */
const FORWARDED_FIELDS = ['instructions', 'reasoning', 'text', 'parallel_tool_calls', 'include'];

export interface ToolNamespace {
  readonly name: string;
  readonly description: string;
}

/**
 * Allowlists documented request fields. Never passes through endpoints, credentials, or fields
 * the preview rejects (`temperature`, `max_output_tokens`, `previous_response_id`, ...).
 */
export function shapeRequest(source: string, namespace: ToolNamespace): string {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw chatgptError('request-failed', 'Invalid ChatGPT request.');
  }
  if (!record(value) || typeof value.model !== 'string' || !Array.isArray(value.input)) {
    throw chatgptError('request-failed', 'ChatGPT requests require a model and an input array.');
  }
  const tools = value.tools ?? [];
  if (
    !Array.isArray(tools) ||
    tools.some(
      (tool) =>
        !record(tool) ||
        tool.type !== 'function' ||
        typeof tool.name !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name),
    )
  ) {
    throw chatgptError(
      'unsupported-capability',
      'ChatGPT plan usage supports local function tools only.',
    );
  }
  const input = value.input.map((item) => {
    if (!record(item)) throw chatgptError('request-failed', 'Invalid ChatGPT input item.');
    // Explicit system message items are rejected by the plan-usage route; use developer instead.
    if (item.role === 'system') return { ...item, role: 'developer' };
    // The model adapter retains normalized tool calls in continuation history.
    if (item.type === 'function_call') return { ...item, namespace: namespace.name };
    return item;
  });
  const body: Record<string, unknown> = { model: value.model, input, store: false, stream: true };
  for (const key of FORWARDED_FIELDS) {
    if (value[key] !== undefined) body[key] = value[key];
  }
  body.tools =
    tools.length === 0
      ? []
      : [{ type: 'namespace', name: namespace.name, description: namespace.description, tools }];
  return JSON.stringify(body);
}

function normalizeItem(item: unknown, namespace: string): unknown {
  if (!record(item) || item.type !== 'function_call') return item;
  const copy = { ...item };
  if (copy.namespace !== undefined && copy.namespace !== namespace) {
    throw chatgptError('invalid-response', 'ChatGPT returned an unknown tool namespace.');
  }
  if (typeof copy.name === 'string' && copy.name.startsWith(`${namespace}.`)) {
    copy.name = copy.name.slice(namespace.length + 1);
  }
  delete copy.namespace;
  return copy;
}

function failure(value: Record<string, unknown>): Error {
  const code = providerCodeFrom(value);
  if (code !== undefined) return providerError(code, undefined, undefined, '');
  return chatgptError(
    'request-failed',
    value.type === 'response.incomplete'
      ? 'ChatGPT ended this response incomplete. The generation was not retried.'
      : 'ChatGPT reported a response failure. The generation was not retried.',
  );
}

/**
 * Re-encodes a provider SSE stream for the shared Responses decoder. Withholds `[DONE]`, which
 * must never be mistaken for `response.completed`.
 */
export async function* shapeStream(
  body: ReadableStream<Uint8Array>,
  namespace: string,
  check: () => void,
  cleanup: () => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let size = 0;
  let previousCR = false;
  const state = { completed: false };
  function parse(block: string): string | undefined {
    if (block.length > MAX_EVENT)
      throw chatgptError('invalid-response', 'ChatGPT stream event is too large.');
    const data = block
      .split('\n')
      .flatMap((line) =>
        line === 'data' ? [''] : line.startsWith('data:') ? [line.slice(5).replace(/^ /, '')] : [],
      )
      .join('\n');
    if (data === '') return undefined;
    if (data === '[DONE]') {
      if (!state.completed)
        throw chatgptError('invalid-response', 'ChatGPT stream ended without response.completed.');
      return undefined;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw chatgptError('invalid-response', 'Invalid ChatGPT stream event.');
    }
    if (!record(event) || typeof event.type !== 'string')
      throw chatgptError('invalid-response', 'Invalid ChatGPT stream event.');
    if (
      ['response.failed', 'response.incomplete', 'error'].includes(event.type) ||
      event.error != null
    ) {
      throw failure(event);
    }
    if (record(event.response) && event.response.error != null) throw failure(event);
    if (event.type === 'response.completed') {
      if (!record(event.response) || event.response.status !== 'completed') {
        throw chatgptError('invalid-response', 'ChatGPT returned an invalid completion event.');
      }
      state.completed = true;
    }
    if (event.item !== undefined) event.item = normalizeItem(event.item, namespace);
    if (record(event.response) && Array.isArray(event.response.output)) {
      event.response.output = event.response.output.map((item) => normalizeItem(item, namespace));
    }
    return `data: ${JSON.stringify(event)}\n\n`;
  }
  try {
    for (;;) {
      check();
      const chunk = await reader.read();
      check();
      let text = decoder.decode(chunk.value, { stream: !chunk.done });
      size += text.length;
      if (size > MAX_STREAM) throw chatgptError('invalid-response', 'ChatGPT stream is too large.');
      if (previousCR && text.startsWith('\n')) text = text.slice(1);
      if (text !== '') previousCR = text.endsWith('\r');
      buffer += text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event !== undefined) yield event;
        if (state.completed) return;
      }
      if (buffer.length > MAX_EVENT)
        throw chatgptError('invalid-response', 'ChatGPT stream event is too large.');
      if (chunk.done) break;
    }
    if (buffer.trim() !== '') {
      const event = parse(buffer);
      if (event !== undefined) yield event;
    }
    if (!state.completed)
      throw chatgptError('invalid-response', 'ChatGPT stream ended without response.completed.');
  } catch (error) {
    check();
    if (error instanceof OpenAIResponsesModelError) throw error;
    throw chatgptError(
      'temporarily-unavailable',
      'ChatGPT stream was interrupted. The generation was not retried automatically.',
    );
  } finally {
    cleanup();
    try {
      await reader.cancel();
    } catch {
      /* Never expose stream errors. */
    }
    reader.releaseLock();
  }
}
