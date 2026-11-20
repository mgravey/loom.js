import type { CodexModelMessage, CodexModelRequest } from '@mgravey/loom-agent-codex';
import { immutableJson, type JsonObject, type JsonValue } from '@mgravey/loom-types';

import type { AnthropicEffort, AnthropicThinking } from './contracts.js';
import { AnthropicMessagesModelError } from './errors.js';

export const DEFAULT_MAX_TOKENS = 32_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/u;
/** Assistant content block types that may be replayed verbatim from a continuation. */
const REPLAYABLE_BLOCKS: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'thinking',
  'redacted_thinking',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'compaction',
]);

export interface AnthropicRequestBodyOptions {
  readonly maxTokens?: number;
  readonly thinking?: AnthropicThinking;
  readonly effort?: AnthropicEffort;
  readonly eagerInputStreaming?: boolean;
  readonly stream?: boolean;
}

export interface ToolAliases {
  readonly byOperation: ReadonlyMap<string, string>;
  readonly byProviderName: ReadonlyMap<string, string>;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): AnthropicMessagesModelError {
  return new AnthropicMessagesModelError('INVALID_REQUEST', message);
}

/**
 * Maps Loom operations (for example `workspace/read-file`) to stable Claude tool names. The name
 * depends only on the operation, so replayed `tool_use` blocks stay valid when tools change.
 */
export function toolAliases(request: CodexModelRequest): ToolAliases {
  const byOperation = new Map<string, string>();
  const byProviderName = new Map<string, string>();
  const add = (operation: string): void => {
    if (byOperation.has(operation)) return;
    const base = TOOL_NAME.test(operation)
      ? operation
      : operation.replaceAll(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 120) || 'tool';
    let name = base;
    for (let suffix = 2; byProviderName.has(name); suffix += 1)
      name = `${base.slice(0, 120)}_${String(suffix)}`;
    byOperation.set(operation, name);
    byProviderName.set(name, operation);
  };
  const seen = new Set<string>();
  for (const tool of request.tools) {
    if (seen.has(tool.operation))
      throw invalidRequest(`Anthropic Messages model received duplicate tool '${tool.operation}'.`);
    seen.add(tool.operation);
    add(tool.operation);
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls) add(call.operation);
    if (message.role === 'tool') add(message.operation);
  }
  return Object.freeze({ byOperation, byProviderName });
}

function providerName(aliases: ToolAliases, operation: string): string {
  const name = aliases.byOperation.get(operation);
  if (name === undefined)
    throw invalidRequest(`Anthropic Messages model received undeclared tool '${operation}'.`);
  return name;
}

function replayable(items: readonly JsonObject[] | undefined): readonly JsonObject[] | undefined {
  if (items === undefined || items.length === 0) return undefined;
  return items.every((item) => typeof item.type === 'string' && REPLAYABLE_BLOCKS.has(item.type))
    ? items
    : undefined;
}

function toolResultContent(result: JsonValue): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function failedResult(result: JsonValue): boolean {
  return isRecord(result) && result.ok === false;
}

function encodeMessages(
  messages: readonly CodexModelMessage[],
  aliases: ToolAliases,
): readonly JsonObject[] {
  const encoded: { role: 'user' | 'assistant'; content: JsonValue[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: readonly JsonValue[]): void => {
    if (blocks.length === 0) return;
    const last = encoded.at(-1);
    // Tool results for one assistant turn must arrive together in a single user message.
    if (last?.role === role && role === 'user') last.content.push(...blocks);
    else encoded.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content }]);
      continue;
    }
    if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.callId,
          content: toolResultContent(message.result),
          ...(failedResult(message.result) ? { is_error: true } : {}),
        },
      ]);
      continue;
    }
    const continuation = replayable(message.continuationItems);
    if (continuation !== undefined) {
      push('assistant', continuation);
      continue;
    }
    const blocks: JsonValue[] = [];
    if (message.content !== '') blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: providerName(aliases, call.operation),
        input: call.input,
      });
    }
    push('assistant', blocks);
  }
  return encoded.map((message) => immutableJson(message) as JsonObject);
}

/** Builds a Messages API body for one Loom model turn. */
export function createAnthropicMessagesRequestBody(
  request: CodexModelRequest,
  model: string,
  options: AnthropicRequestBodyOptions = {},
): JsonObject {
  const candidate: unknown = request;
  if (
    !isRecord(candidate) ||
    typeof candidate.instructions !== 'string' ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.tools)
  ) {
    throw invalidRequest('Anthropic Messages model received an invalid agent request.');
  }
  if (request.contextItems !== undefined && request.contextItems.length > 0) {
    throw invalidRequest(
      'Anthropic Messages model cannot replay provider context items from another adapter.',
    );
  }
  const aliases = toolAliases(request);
  const messages = encodeMessages(request.messages, aliases);
  if (messages.length === 0 || messages[0]?.role !== 'user')
    throw invalidRequest('Anthropic Messages requests must start with a user message.');
  const tools = request.tools.map((tool) => ({
    name: providerName(aliases, tool.operation),
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(options.eagerInputStreaming === true ? { eager_input_streaming: true } : {}),
  }));
  return immutableJson({
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.instructions.trim() === '' ? {} : { system: request.instructions }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
    stream: options.stream ?? true,
  }) as JsonObject;
}
