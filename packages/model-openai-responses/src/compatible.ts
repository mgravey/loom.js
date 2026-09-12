import type { CodexModel, CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import type { OperationContext } from '@mgravey/loom-plugin-api';
import { immutableJson, type JsonObject } from '@mgravey/loom-types';

import type {
  OpenAIApiKeySupplier,
  OpenAICompatibleResponsesBody,
  OpenAICompatibleResponsesHttpRequest,
  OpenAICompatibleResponsesHttpResponse,
  OpenAICompatibleResponsesModelOptions,
} from './contracts.js';
import { OpenAIResponsesModelError } from './errors.js';
import { createOpenAIResponsesRequestBody, decodeOpenAIResponses } from './model.js';

const MAXIMUM_STREAM_CHARACTERS = 8 * 1024 * 1024;
const MAXIMUM_EVENT_CHARACTERS = 1024 * 1024;

interface ValidatedOptions {
  readonly reasoningEffort?: OpenAICompatibleResponsesModelOptions['reasoningEffort'];
  readonly model: string;
  readonly endpoint: string;
  readonly send: OpenAICompatibleResponsesModelOptions['fetch'];
  readonly getApiKey?: OpenAIApiKeySupplier;
  readonly headers: Readonly<Record<string, string>>;
  readonly stream: boolean;
}

interface ParsedStreamEvent {
  readonly done: boolean;
  readonly value?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      `OpenAI-compatible Responses model ${label} must be a non-empty string.`,
    );
  }
  return value;
}

function validateHeaders(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value ?? {})) {
    if (name.trim() === '' || headerValue.trim() === '') {
      throw new OpenAIResponsesModelError(
        'INVALID_CONFIGURATION',
        'OpenAI-compatible Responses headers must contain non-empty names and values.',
      );
    }
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'content-type') {
      throw new OpenAIResponsesModelError(
        'INVALID_CONFIGURATION',
        `OpenAI-compatible Responses header '${name}' is managed by the adapter.`,
      );
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function validateOptions(options: OpenAICompatibleResponsesModelOptions): ValidatedOptions {
  if (!isRecord(options) || typeof options.fetch !== 'function') {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI-compatible Responses model options and an injected fetch adapter are required.',
    );
  }
  if (options.stream !== undefined && typeof options.stream !== 'boolean') {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI-compatible Responses stream must be boolean.',
    );
  }
  if (
    options.reasoningEffort !== undefined &&
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      options.reasoningEffort,
    )
  ) {
    throw new OpenAIResponsesModelError('INVALID_CONFIGURATION', 'Invalid reasoning effort.');
  }
  const authentication = options.authentication;
  const getApiKey =
    authentication === undefined
      ? undefined
      : typeof authentication === 'function'
        ? authentication
        : isRecord(authentication) && typeof authentication.getAccessToken === 'function'
          ? () => authentication.getAccessToken()
          : undefined;
  if (authentication !== undefined && getApiKey === undefined) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI-compatible Responses authentication is invalid.',
    );
  }
  return Object.freeze({
    model: requiredString(options.model, 'model'),
    endpoint: requiredString(options.endpoint, 'endpoint'),
    send: options.fetch,
    ...(getApiKey === undefined ? {} : { getApiKey }),
    headers: validateHeaders(options.headers),
    stream: options.stream ?? true,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
}

async function apiKey(options: ValidatedOptions): Promise<string | undefined> {
  if (options.getApiKey === undefined) return undefined;
  try {
    const value = await options.getApiKey();
    if (typeof value !== 'string' || value.trim() === '') throw new Error('invalid key');
    return value;
  } catch {
    throw new OpenAIResponsesModelError(
      'AUTHENTICATION_FAILED',
      'OpenAI-compatible Responses authentication failed.',
    );
  }
}

async function sendRequest(
  options: ValidatedOptions,
  request: OpenAICompatibleResponsesHttpRequest,
  context?: OperationContext,
): Promise<OpenAICompatibleResponsesHttpResponse> {
  try {
    const response: unknown = await options.send(request);
    context?.signal?.throwIfCancelled();
    if (
      !isRecord(response) ||
      !Number.isInteger(response.status) ||
      (typeof response.body !== 'string' &&
        (!isRecord(response.body) ||
          typeof (response.body as { readonly [Symbol.asyncIterator]?: unknown })[
            Symbol.asyncIterator
          ] !== 'function')) ||
      (response.contentType !== undefined && typeof response.contentType !== 'string')
    ) {
      throw new Error('invalid response');
    }
    return response as unknown as OpenAICompatibleResponsesHttpResponse;
  } catch (error) {
    if (error instanceof OpenAIResponsesModelError) throw error;
    context?.signal?.throwIfCancelled();
    throw new OpenAIResponsesModelError(
      'TRANSPORT_FAILED',
      'OpenAI-compatible Responses transport failed.',
    );
  }
}

function malformed(message = 'OpenAI-compatible Responses stream is malformed.') {
  return new OpenAIResponsesModelError('MALFORMED_RESPONSE', message);
}

function parsedEvent(block: string): ParsedStreamEvent | undefined {
  if (block.length > MAXIMUM_EVENT_CHARACTERS) throw malformed('Responses SSE event is too large.');
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':') || line.startsWith('event:')) continue;
    if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  const source = data.join('\n');
  if (source === '[DONE]') return Object.freeze({ done: true });
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw malformed();
  }
  if (!isRecord(value) || typeof value.type !== 'string') throw malformed();
  return Object.freeze({ done: false, value });
}

async function* sseEvents(
  body: OpenAICompatibleResponsesBody,
  context?: OperationContext,
): AsyncIterable<ParsedStreamEvent> {
  const source: AsyncIterable<string> =
    typeof body === 'string'
      ? Object.freeze({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield body;
          },
        })
      : body;
  let buffer = '';
  let characters = 0;
  for await (const chunk of source) {
    context?.signal?.throwIfCancelled();
    if (typeof chunk !== 'string') throw malformed();
    characters += chunk.length;
    if (characters > MAXIMUM_STREAM_CHARACTERS) {
      throw malformed('OpenAI-compatible Responses stream is too large.');
    }
    buffer += chunk.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parsedEvent(block);
      if (event !== undefined) yield event;
    }
    if (buffer.length > MAXIMUM_EVENT_CHARACTERS) {
      throw malformed('Responses SSE event is too large.');
    }
  }
  if (buffer.trim() !== '') {
    const event = parsedEvent(buffer);
    if (event !== undefined) yield event;
  }
}

async function completeBody(
  body: OpenAICompatibleResponsesBody,
  context?: OperationContext,
): Promise<string> {
  if (typeof body === 'string') {
    if (body.length > MAXIMUM_STREAM_CHARACTERS) throw malformed('Responses body is too large.');
    return body;
  }
  let result = '';
  for await (const chunk of body) {
    context?.signal?.throwIfCancelled();
    if (typeof chunk !== 'string') throw malformed();
    result += chunk;
    if (result.length > MAXIMUM_STREAM_CHARACTERS) {
      throw malformed('Responses body is too large.');
    }
  }
  return result;
}

function normalizedItem(value: unknown): JsonObject {
  let item;
  try {
    item = immutableJson(value);
  } catch {
    throw malformed();
  }
  if (!isRecord(item)) throw malformed();
  return item;
}

function eventKey(event: Readonly<Record<string, unknown>>, fallback: number): string {
  if (Number.isInteger(event.output_index)) return `index:${String(event.output_index)}`;
  if (typeof event.item_id === 'string') return `id:${event.item_id}`;
  const item = isRecord(event.item) ? event.item : undefined;
  return typeof item?.id === 'string' ? `id:${item.id}` : `event:${String(fallback)}`;
}

function eventOutput(event: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  return Array.isArray(response?.output) ? response.output : undefined;
}

async function* decodeCompatibleStream(
  body: OpenAICompatibleResponsesBody,
  request: CodexModelRequest,
  context?: OperationContext,
): AsyncIterable<CodexModelEvent> {
  const items = new Map<string, JsonObject>();
  const order: string[] = [];
  let streamedText = false;
  let terminal = false;
  let eventNumber = 0;
  const setItem = (key: string, value: unknown): void => {
    if (!items.has(key)) order.push(key);
    items.set(key, normalizedItem(value));
  };

  for await (const parsed of sseEvents(body, context)) {
    if (parsed.done) {
      terminal = true;
      break;
    }
    const event = parsed.value;
    if (event === undefined) continue;
    eventNumber += 1;
    const type = event.type;
    if (type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw malformed();
      if (event.delta !== '') {
        streamedText = true;
        yield { type: 'text', text: event.delta };
      }
      continue;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (!isRecord(event.item)) throw malformed();
      setItem(eventKey(event, eventNumber), event.item);
      continue;
    }
    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.function_call_arguments.done'
    ) {
      const key = eventKey(event, eventNumber);
      const current = items.get(key);
      if (current?.type !== 'function_call') throw malformed();
      const fragment = type.endsWith('.delta') ? event.delta : event.arguments;
      if (typeof fragment !== 'string') throw malformed();
      const argumentsValue = type.endsWith('.delta')
        ? `${typeof current.arguments === 'string' ? current.arguments : ''}${fragment}`
        : fragment;
      setItem(key, { ...current, arguments: argumentsValue });
      continue;
    }
    if (type === 'response.completed') {
      const output = eventOutput(event);
      if (output !== undefined) {
        output.forEach((item, index) => setItem(`index:${String(index)}`, item));
      }
      terminal = true;
      break;
    }
    if (type === 'response.incomplete') {
      throw new OpenAIResponsesModelError(
        'INCOMPLETE_RESPONSE',
        'OpenAI-compatible Responses request ended incomplete.',
      );
    }
    if (type === 'response.failed' || type === 'error') {
      throw new OpenAIResponsesModelError(
        'PROVIDER_ERROR',
        'OpenAI-compatible Responses provider reported a failure.',
      );
    }
  }
  if (!terminal) throw malformed('OpenAI-compatible Responses stream ended without completion.');

  const output = order.flatMap((key) => {
    const item = items.get(key);
    return item === undefined ? [] : [item];
  });
  let decodedFinal = false;
  let hasToolCall = false;
  for await (const event of decodeOpenAIResponses(
    JSON.stringify({ status: 'completed', output }),
    request,
    context,
  )) {
    if (event.type === 'text' && streamedText) continue;
    if (event.type === 'tool-call') hasToolCall = true;
    if (event.type === 'completed') {
      decodedFinal = event.final ?? false;
      continue;
    }
    yield event;
  }
  yield { type: 'completed', final: decodedFinal || (streamedText && !hasToolCall) };
}

function isEventStream(response: OpenAICompatibleResponsesHttpResponse): boolean {
  if (response.contentType !== undefined) {
    return response.contentType.toLowerCase().includes('text/event-stream');
  }
  if (typeof response.body !== 'string') return true;
  const prefix = response.body.trimStart();
  return prefix.startsWith('data:') || prefix.startsWith('event:') || prefix.startsWith(':');
}

/** Creates a direct model for CORS-capable local, LAN, or otherwise OpenAI-compatible servers. */
export function createOpenAICompatibleResponsesModel(
  options: OpenAICompatibleResponsesModelOptions,
): CodexModel {
  const validated = validateOptions(options);
  return Object.freeze({
    async *generate(request: CodexModelRequest, context?: OperationContext) {
      context?.signal?.throwIfCancelled();
      const key = await apiKey(validated);
      context?.signal?.throwIfCancelled();
      const httpRequest: OpenAICompatibleResponsesHttpRequest = Object.freeze({
        method: 'POST',
        url: validated.endpoint,
        headers: Object.freeze({
          ...validated.headers,
          Accept: 'text/event-stream, application/json',
          ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(
          createOpenAIResponsesRequestBody(request, validated.model, {
            portable: true,
            ...(validated.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: validated.reasoningEffort }),
            stream: validated.stream,
          }),
        ),
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      });
      const response = await sendRequest(validated, httpRequest, context);
      if (response.status < 200 || response.status >= 300) {
        throw new OpenAIResponsesModelError(
          'HTTP_ERROR',
          'OpenAI-compatible Responses request was rejected.',
          { status: response.status },
        );
      }
      if (isEventStream(response)) {
        yield* decodeCompatibleStream(response.body, request, context);
      } else {
        yield* decodeOpenAIResponses(await completeBody(response.body, context), request, context);
      }
    },
  });
}
