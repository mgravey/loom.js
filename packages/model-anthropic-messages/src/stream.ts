import type { CodexModelEvent } from '@mgravey/loom-agent-codex';
import type { OperationContext } from '@mgravey/loom-plugin-api';
import { immutableJson, type JsonObject, type JsonValue } from '@mgravey/loom-types';

import type { AnthropicMessagesBody, AnthropicUsage } from './contracts.js';
import { AnthropicMessagesModelError, providerType, retryableFailure } from './errors.js';
import { isRecord, type ToolAliases } from './request.js';

const MAXIMUM_STREAM_CHARACTERS = 32 * 1024 * 1024;
const MAXIMUM_EVENT_CHARACTERS = 1024 * 1024;
const MAXIMUM_BLOCK_CHARACTERS = 8 * 1024 * 1024;
const MAXIMUM_BLOCKS = 4096;
const REFUSAL_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/u;

function malformed(message = 'Anthropic Messages stream is malformed.') {
  return new AnthropicMessagesModelError('MALFORMED_RESPONSE', message);
}

/** Splits an SSE body into parsed JSON `data` payloads. Comments and `event:` lines are ignored. */
export async function* sseEvents(
  body: AnthropicMessagesBody,
  context?: OperationContext,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const source: AsyncIterable<string> =
    typeof body === 'string'
      ? {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield body;
          },
        }
      : body;
  let buffer = '';
  let characters = 0;
  let previousCarriageReturn = false;
  const parse = (block: string): Readonly<Record<string, unknown>> | undefined => {
    if (block.length > MAXIMUM_EVENT_CHARACTERS)
      throw malformed('Anthropic SSE event is too large.');
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === 'data') data.push('');
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
    }
    if (data.length === 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(data.join('\n'));
    } catch {
      throw malformed();
    }
    if (!isRecord(value) || typeof value.type !== 'string') throw malformed();
    return value;
  };
  for await (const chunk of source) {
    context?.signal?.throwIfCancelled();
    if (typeof chunk !== 'string') throw malformed();
    characters += chunk.length;
    if (characters > MAXIMUM_STREAM_CHARACTERS)
      throw malformed('Anthropic Messages stream is too large.');
    // A CR/LF pair can straddle chunks. Normalize it only once.
    const normalized = previousCarriageReturn && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    if (chunk !== '') previousCarriageReturn = chunk.endsWith('\r');
    buffer += normalized.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const event = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event !== undefined) yield event;
    }
    if (buffer.length > MAXIMUM_EVENT_CHARACTERS)
      throw malformed('Anthropic SSE event is too large.');
  }
  if (buffer.trim() !== '') {
    const event = parse(buffer);
    if (event !== undefined) yield event;
  }
}

interface BlockState {
  readonly type: string;
  block: Record<string, unknown>;
  json: string;
  closed: boolean;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageFrom(value: unknown, previous: AnthropicUsage): AnthropicUsage {
  if (!isRecord(value)) return previous;
  const next: Record<string, number> = { ...previous };
  const fields: readonly (readonly [string, keyof AnthropicUsage])[] = [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ];
  for (const [source, target] of fields) {
    const parsed = count(value[source]);
    if (parsed !== undefined) next[target] = parsed;
  }
  return next;
}

function streamError(event: Readonly<Record<string, unknown>>): AnthropicMessagesModelError {
  const error = isRecord(event.error) ? event.error : {};
  const type = providerType(error.type);
  return new AnthropicMessagesModelError(
    'PROVIDER_ERROR',
    type === 'overloaded_error'
      ? 'Anthropic is temporarily overloaded. Retry later.'
      : 'Anthropic reported a streaming failure. The generation was not retried.',
    {
      ...(type === undefined ? {} : { providerCode: type }),
      retryable: type === undefined ? false : retryableFailure(undefined, type),
    },
  );
}

function blockIndex(event: Readonly<Record<string, unknown>>): number {
  const index = event.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAXIMUM_BLOCKS)
    throw malformed();
  return index;
}

/** Decodes a Messages SSE stream into Loom model events. */
export async function* decodeAnthropicStream(
  body: AnthropicMessagesBody,
  aliases: ToolAliases,
  context?: OperationContext,
  onUsage?: (usage: AnthropicUsage) => void,
): AsyncIterable<CodexModelEvent> {
  const blocks = new Map<number, BlockState>();
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;
  let refusalCategory: string | undefined;
  let usage: AnthropicUsage = {};

  for await (const event of sseEvents(body, context)) {
    const type = event.type;
    if (type === 'ping') continue;
    if (type === 'error') throw streamError(event);
    if (type === 'message_start') {
      if (started || !isRecord(event.message)) throw malformed();
      started = true;
      usage = usageFrom(event.message.usage, usage);
      continue;
    }
    if (!started) throw malformed('Anthropic Messages stream did not start with message_start.');
    if (type === 'content_block_start') {
      const index = blockIndex(event);
      const block = event.content_block;
      if (blocks.has(index) || !isRecord(block) || typeof block.type !== 'string')
        throw malformed();
      const copy: Record<string, unknown> = { ...block };
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        if (typeof block.id !== 'string' || block.id === '' || typeof block.name !== 'string')
          throw malformed('Anthropic tool_use block is missing its id or name.');
      }
      blocks.set(index, { type: block.type, block: copy, json: '', closed: false });
      continue;
    }
    if (type === 'content_block_delta') {
      const state = blocks.get(blockIndex(event));
      const delta = event.delta;
      if (state === undefined || state.closed || !isRecord(delta) || typeof delta.type !== 'string')
        throw malformed();
      if (delta.type === 'text_delta') {
        if (typeof delta.text !== 'string' || state.type !== 'text') throw malformed();
        state.block.text = `${typeof state.block.text === 'string' ? state.block.text : ''}${delta.text}`;
        if ((state.block.text as string).length > MAXIMUM_BLOCK_CHARACTERS) throw malformed();
        if (delta.text !== '') yield { type: 'text', text: delta.text };
      } else if (delta.type === 'input_json_delta') {
        if (typeof delta.partial_json !== 'string') throw malformed();
        state.json += delta.partial_json;
        if (state.json.length > MAXIMUM_BLOCK_CHARACTERS) throw malformed();
      } else if (delta.type === 'thinking_delta') {
        if (typeof delta.thinking !== 'string') throw malformed();
        state.block.thinking = `${typeof state.block.thinking === 'string' ? state.block.thinking : ''}${delta.thinking}`;
        if ((state.block.thinking as string).length > MAXIMUM_BLOCK_CHARACTERS) throw malformed();
      } else if (delta.type === 'signature_delta') {
        if (typeof delta.signature !== 'string') throw malformed();
        state.block.signature = delta.signature;
      } else if (delta.type === 'citations_delta') {
        const citations: unknown[] = Array.isArray(state.block.citations)
          ? (state.block.citations as unknown[])
          : [];
        state.block.citations = [...citations, delta.citation];
      }
      // Unknown delta types are ignored, as the versioning policy allows new variants.
      continue;
    }
    if (type === 'content_block_stop') {
      const state = blocks.get(blockIndex(event));
      if (state === undefined || state.closed) throw malformed();
      state.closed = true;
      if (state.type === 'tool_use' || state.type === 'server_tool_use') {
        if (state.json.trim() !== '') {
          let input: unknown;
          try {
            input = JSON.parse(state.json);
          } catch {
            throw malformed('Anthropic tool input is invalid JSON.');
          }
          if (!isRecord(input)) throw malformed('Anthropic tool input must be a JSON object.');
          state.block.input = input;
        } else if (!isRecord(state.block.input)) {
          state.block.input = {};
        }
      }
      continue;
    }
    if (type === 'message_delta') {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason.slice(0, 64);
      const details = isRecord(delta.stop_details) ? delta.stop_details : undefined;
      if (typeof details?.category === 'string' && REFUSAL_CATEGORY.test(details.category))
        refusalCategory = details.category;
      usage = usageFrom(event.usage, usage);
      continue;
    }
    if (type === 'message_stop') {
      stopped = true;
      break;
    }
    // Unknown event types are ignored, as the versioning policy allows new variants.
  }
  if (!stopped) throw malformed('Anthropic Messages stream ended without message_stop.');
  context?.signal?.throwIfCancelled();
  if (onUsage !== undefined) {
    try {
      onUsage(Object.freeze({ ...usage }));
    } catch {
      /* Usage observers must not affect generation. */
    }
  }
  if ([...blocks.values()].some((state) => !state.closed))
    throw malformed('Anthropic Messages stream ended with an open content block.');
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    throw new AnthropicMessagesModelError(
      'INCOMPLETE_RESPONSE',
      stopReason === 'max_tokens'
        ? 'Anthropic stopped at the max_tokens limit. Pending tool calls were not run.'
        : 'Anthropic stopped because the context window was exceeded.',
      {
        stopReason,
        ...(stopReason === 'model_context_window_exceeded'
          ? { contextCompactionRequired: true }
          : {}),
      },
    );
  }
  if (stopReason === 'refusal') {
    throw new AnthropicMessagesModelError('REFUSED', 'Claude declined this request.', {
      stopReason,
      ...(refusalCategory === undefined ? {} : { refusalCategory }),
    });
  }

  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right);
  const calls: CodexModelEvent[] = [];
  for (const [, state] of ordered) {
    let item: JsonValue;
    try {
      item = immutableJson(state.block);
    } catch {
      throw malformed();
    }
    yield { type: 'continuation', item: item as JsonObject };
    if (state.type === 'tool_use') {
      const id = state.block.id as string;
      const name = state.block.name as string;
      calls.push({
        type: 'tool-call',
        call: {
          id,
          operation: aliases.byProviderName.get(name) ?? name,
          input: immutableJson(state.block.input) as JsonObject,
        },
      });
    }
  }
  yield* calls;
  // pause_turn asks the caller to continue the same assistant turn with the replayed content.
  yield { type: 'completed', final: stopReason !== 'pause_turn' };
}
