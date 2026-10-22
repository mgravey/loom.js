import { OpenAIResponsesModelError } from '@mgravey/loom-model-openai-responses';

const NAMESPACE = 'loom';
const MAX_EVENT = 1024 * 1024;
const MAX_STREAM = 8 * 1024 * 1024;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ChatGPTDirectTokenErrorCode =
  | 'invalid_grant'
  | 'invalid_refresh_token'
  | 'token_expired'
  | 'refresh_token_expired'
  | 'refresh_token_invalidated'
  | 'refresh_token_reused'
  | 'invalid_client';

/** Messages are authored locally; raw provider bodies/errors are never attached as a cause. */
export class ChatGPTDirectError extends OpenAIResponsesModelError {
  public readonly invalidatesSession: boolean;
  public readonly tokenErrorCode: ChatGPTDirectTokenErrorCode | undefined;

  public constructor(
    message: string,
    options: {
      readonly status?: number;
      readonly invalidatesSession?: boolean;
      readonly tokenErrorCode?: ChatGPTDirectTokenErrorCode;
    } = {},
  ) {
    super('PROVIDER_ERROR', message, options);
    this.name = 'ChatGPTDirectError';
    this.invalidatesSession = options.invalidatesSession ?? false;
    this.tokenErrorCode = options.tokenErrorCode;
  }
}

export function directError(message: string): ChatGPTDirectError {
  return new ChatGPTDirectError(message);
}

/** Only allow documented preview request fields; never pass through endpoint or credentials. */
export function directRequest(source: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw directError('Invalid ChatGPT request.');
  }
  if (!record(value) || typeof value.model !== 'string' || !Array.isArray(value.input)) {
    throw directError('ChatGPT requests require a model and an input array.');
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
    throw directError('This ChatGPT prototype supports local function tools only.');
  }
  const input = value.input.map((item) => {
    if (!record(item)) throw directError('Invalid ChatGPT input item.');
    if (item.role === 'system') return { ...item, role: 'developer' };
    // The model adapter retains normalized tool calls in continuation history.
    if (item.type === 'function_call') return { ...item, namespace: NAMESPACE };
    return item;
  });
  const body: Record<string, unknown> = { model: value.model, input, store: false, stream: true };
  for (const key of ['instructions', 'reasoning', 'text', 'parallel_tool_calls', 'include']) {
    if (value[key] !== undefined) body[key] = value[key];
  }
  body.tools =
    tools.length === 0
      ? []
      : [
          {
            type: 'namespace',
            name: NAMESPACE,
            description: 'Tools provided by the Loom.js browser workbench.',
            tools,
          },
        ];
  return JSON.stringify(body);
}

function normalizeItem(item: unknown): unknown {
  if (!record(item) || item.type !== 'function_call') return item;
  const copy = { ...item };
  if (copy.namespace !== undefined && copy.namespace !== NAMESPACE) {
    throw directError('ChatGPT returned an unknown tool namespace.');
  }
  if (typeof copy.name === 'string' && copy.name.startsWith(`${NAMESPACE}.`)) {
    copy.name = copy.name.slice(NAMESPACE.length + 1);
  }
  delete copy.namespace;
  return copy;
}

function failure(value: Record<string, unknown>): Error {
  const response = record(value.response) ? value.response : undefined;
  const error = record(response?.error)
    ? response.error
    : record(value.error)
      ? value.error
      : value;
  if (error.code === 'subscription_sharing_usage_limit_exceeded') {
    return directError(
      'This ChatGPT account has reached its plan-sharing usage limit. Review ChatGPT Settings → Usage.',
    );
  }
  if (error.code === 'subscription_sharing_usage_unavailable') {
    return directError(
      'ChatGPT plan sharing is currently unavailable for this account. Review ChatGPT Settings → Usage.',
    );
  }
  return directError(
    value.type === 'response.incomplete'
      ? 'ChatGPT ended this response incomplete. The generation was not retried.'
      : 'ChatGPT reported a response failure. The generation was not retried.',
  );
}

/** Withhold [DONE]; the shared decoder must never mistake it for response.completed. */
export async function* directStream(
  body: ReadableStream<Uint8Array>,
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
    if (block.length > MAX_EVENT) throw directError('ChatGPT stream event is too large.');
    const data = block
      .split('\n')
      .flatMap((line) =>
        line === 'data' ? [''] : line.startsWith('data:') ? [line.slice(5).replace(/^ /, '')] : [],
      )
      .join('\n');
    if (data === '') return undefined;
    if (data === '[DONE]') {
      if (!state.completed) throw directError('ChatGPT stream ended without response.completed.');
      return undefined;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw directError('Invalid ChatGPT stream event.');
    }
    if (!record(event) || typeof event.type !== 'string')
      throw directError('Invalid ChatGPT stream event.');
    if (
      ['response.failed', 'response.incomplete', 'error'].includes(event.type) ||
      event.error != null
    ) {
      throw failure(event);
    }
    if (record(event.response) && event.response.error != null) throw failure(event);
    if (event.type === 'response.completed') {
      if (!record(event.response) || event.response.status !== 'completed') {
        throw directError('ChatGPT returned an invalid completion event.');
      }
      state.completed = true;
    }
    if (event.item !== undefined) event.item = normalizeItem(event.item);
    if (record(event.response) && Array.isArray(event.response.output)) {
      event.response.output = event.response.output.map(normalizeItem);
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
      if (size > MAX_STREAM) throw directError('ChatGPT stream is too large.');
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
      if (buffer.length > MAX_EVENT) throw directError('ChatGPT stream event is too large.');
      if (chunk.done) break;
    }
    if (buffer.trim() !== '') {
      const event = parse(buffer);
      if (event !== undefined) yield event;
    }
    if (!state.completed) throw directError('ChatGPT stream ended without response.completed.');
  } catch (error) {
    check();
    if (error instanceof OpenAIResponsesModelError) throw error;
    throw directError('ChatGPT stream was interrupted. The generation was not retried.');
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
