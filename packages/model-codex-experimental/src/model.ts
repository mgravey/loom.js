import type {
  CodexModel,
  CodexModelEvent,
  CodexModelMessage,
  CodexModelRequest,
} from '@loom/agent-codex';
import type { OperationContext } from '@loom/plugin-api';
import type { JsonObject, JsonValue } from '@loom/types';

import type {
  AccessTokenSupplier,
  AccountIdSupplier,
  CodexExperimentalDirectFetchOptions,
  CreateCodexExperimentalModelOptions,
  CodexResponsesFetch,
  CodexResponsesHttpRequest,
  CodexResponsesHttpResponse,
  CodexResponsesRequest,
  CodexResponsesSseMessage,
  CodexResponsesTransport,
} from './contracts.js';
import { CodexExperimentalModelError } from './errors.js';

const DEFAULT_ORIGINATOR = 'loom_js_experimental';

interface ValidatedBrokeredOptions {
  readonly kind: 'brokered';
  readonly model: string;
  readonly send: CodexResponsesTransport['send'];
}

interface ValidatedDirectOptions {
  readonly kind: 'direct';
  readonly endpoint: string;
  readonly model: string;
  readonly getAccessToken: AccessTokenSupplier;
  readonly send: CodexResponsesFetch;
  readonly getAccountId?: AccountIdSupplier;
  readonly originator: string;
  readonly headers: Readonly<Record<string, string>>;
}

type ValidatedOptions = ValidatedBrokeredOptions | ValidatedDirectOptions;

interface PendingCall {
  readonly key: string;
  id?: string;
  operation?: string;
  arguments: string;
  emitted: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      `Experimental Codex model ${label} must be a non-empty string.`,
    );
  }
  return value;
}

function validateHeaders(value: Readonly<Record<string, string>> | undefined) {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value ?? {})) {
    if (name.trim() === '' || headerValue.trim() === '') {
      throw new CodexExperimentalModelError(
        'INVALID_CONFIGURATION',
        'Experimental Codex model headers must contain non-empty names and values.',
      );
    }
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'content-type') {
      throw new CodexExperimentalModelError(
        'INVALID_CONFIGURATION',
        `Experimental Codex model header '${name}' is managed by the adapter.`,
      );
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function validateOptions(options: CreateCodexExperimentalModelOptions): ValidatedOptions {
  if (!isRecord(options)) {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Experimental Codex model options are required.',
    );
  }
  const hasTransport = 'transport' in options;
  const hasFetch = 'fetch' in options;
  if (hasTransport === hasFetch) {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Experimental Codex model requires exactly one brokered transport or direct fetch adapter.',
    );
  }
  const model = requiredString(options.model, 'model');
  if (hasTransport) {
    const transport = options.transport as CodexResponsesTransport;
    if (!isRecord(transport) || typeof transport.send !== 'function') {
      throw new CodexExperimentalModelError(
        'INVALID_CONFIGURATION',
        'Experimental Codex model requires an injected brokered transport.',
      );
    }
    return Object.freeze({
      kind: 'brokered',
      model,
      send: (request: CodexResponsesRequest) => transport.send(request),
    });
  }

  const direct = options as CodexExperimentalDirectFetchOptions;
  const authentication = direct.authentication;
  const getAccessToken =
    typeof authentication === 'function'
      ? authentication
      : isRecord(authentication) && typeof authentication.getAccessToken === 'function'
        ? () => (authentication as { getAccessToken(): Promise<string> }).getAccessToken()
        : undefined;
  if (getAccessToken === undefined) {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Experimental Codex model requires an authentication provider or access-token callback.',
    );
  }
  if (typeof direct.fetch !== 'function') {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Experimental Codex model direct mode requires an injected fetch adapter.',
    );
  }
  const accountId = direct.accountId;
  const getAccountId =
    typeof accountId === 'function'
      ? accountId
      : typeof accountId === 'string'
        ? () => Promise.resolve(accountId)
        : undefined;
  return Object.freeze({
    kind: 'direct',
    endpoint: requiredString(direct.endpoint, 'endpoint'),
    model,
    getAccessToken,
    send: direct.fetch,
    ...(getAccountId === undefined ? {} : { getAccountId }),
    originator: requiredString(direct.originator ?? DEFAULT_ORIGINATOR, 'originator'),
    headers: validateHeaders(direct.headers),
  });
}

interface OperationAliases {
  readonly byOperation: ReadonlyMap<string, string>;
  readonly byProviderName: ReadonlyMap<string, string>;
}

function operationAliases(request: CodexModelRequest): OperationAliases {
  const byOperation = new Map<string, string>();
  const byProviderName = new Map<string, string>();
  const add = (operation: string): void => {
    const index = byOperation.size;
    const readable = operation.replaceAll(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 48);
    const providerName = `loom_${String(index)}_${readable}`;
    byOperation.set(operation, providerName);
    byProviderName.set(providerName, operation);
  };
  for (const tool of request.tools) {
    if (byOperation.has(tool.operation)) {
      throw new CodexExperimentalModelError(
        'INVALID_REQUEST',
        `Experimental Codex model received duplicate tool operation '${tool.operation}'.`,
      );
    }
    add(tool.operation);
  }
  for (const message of request.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (!byOperation.has(call.operation)) add(call.operation);
    }
  }
  return Object.freeze({ byOperation, byProviderName });
}

function providerOperation(aliases: OperationAliases, operation: string): string {
  const providerName = aliases.byOperation.get(operation);
  if (providerName === undefined) {
    throw new CodexExperimentalModelError(
      'INVALID_REQUEST',
      `Experimental Codex model received an undeclared tool operation '${operation}'.`,
    );
  }
  return providerName;
}

function encodeMessage(
  message: CodexModelMessage,
  aliases: OperationAliases,
): readonly JsonValue[] {
  if (message.role === 'user') {
    return [{ role: 'user', content: [{ type: 'input_text', text: message.content }] }];
  }
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.callId,
        output: JSON.stringify(message.result),
      },
    ];
  }
  const items: JsonValue[] = [];
  if (message.content !== '') {
    items.push({
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content }],
    });
  }
  for (const call of message.toolCalls) {
    items.push({
      type: 'function_call',
      call_id: call.id,
      name: providerOperation(aliases, call.operation),
      arguments: JSON.stringify(call.input),
    });
  }
  return items;
}

export function createCodexResponsesRequestBody(
  request: CodexModelRequest,
  model: string,
): JsonObject {
  const candidate: unknown = request;
  if (
    !isRecord(candidate) ||
    typeof candidate.instructions !== 'string' ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.tools)
  ) {
    throw new CodexExperimentalModelError(
      'INVALID_REQUEST',
      'Experimental Codex model received an invalid agent request.',
    );
  }
  const aliases = operationAliases(request);
  return {
    model,
    instructions: request.instructions,
    input: request.messages.flatMap((message) => encodeMessage(message, aliases)),
    tools: request.tools.map((tool) => ({
      type: 'function',
      name: providerOperation(aliases, tool.operation),
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
}

async function accessToken(options: ValidatedDirectOptions): Promise<string> {
  try {
    const token = await options.getAccessToken();
    if (typeof token !== 'string' || token.trim() === '') throw new Error('invalid token');
    return token;
  } catch {
    throw new CodexExperimentalModelError(
      'AUTHENTICATION_FAILED',
      'Experimental Codex authentication failed.',
    );
  }
}

async function accountId(options: ValidatedDirectOptions): Promise<string | undefined> {
  if (options.getAccountId === undefined) return undefined;
  try {
    const value = await options.getAccountId();
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') throw new Error('invalid account id');
    return value;
  } catch {
    throw new CodexExperimentalModelError(
      'AUTHENTICATION_FAILED',
      'Experimental Codex account selection failed.',
    );
  }
}

async function sendRequest<Request>(
  send: (request: Request) => Promise<CodexResponsesHttpResponse>,
  request: Request,
  signal: OperationContext['signal'],
): Promise<CodexResponsesHttpResponse> {
  try {
    const response = await send(request);
    const candidate: unknown = response;
    if (
      !isRecord(candidate) ||
      typeof candidate.status !== 'number' ||
      (typeof candidate.body !== 'object' && typeof candidate.body !== 'function') ||
      candidate.body === null ||
      typeof (candidate.body as { readonly [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] !== 'function'
    ) {
      throw new Error('bad response');
    }
    return response;
  } catch (error) {
    if (error instanceof CodexExperimentalModelError) throw error;
    signal?.throwIfCancelled();
    throw new CodexExperimentalModelError(
      'TRANSPORT_FAILED',
      'Experimental Codex transport failed.',
    );
  }
}

export async function* parseCodexResponsesSse(
  chunks: AsyncIterable<string>,
): AsyncIterable<CodexResponsesSseMessage> {
  let buffer = '';
  let pendingCarriageReturn = false;
  for await (const chunk of chunks) {
    if (typeof chunk !== 'string') {
      throw new CodexExperimentalModelError(
        'MALFORMED_RESPONSE',
        'Experimental Codex transport returned a non-text stream chunk.',
      );
    }
    let normalizedChunk: string = pendingCarriageReturn ? `\r${chunk}` : chunk;
    pendingCarriageReturn = normalizedChunk.endsWith('\r');
    if (pendingCarriageReturn) normalizedChunk = normalizedChunk.slice(0, -1);
    buffer += normalizedChunk.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed !== undefined) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (pendingCarriageReturn) buffer += '\n';
  if (buffer.trim() !== '') {
    const parsed = parseSseBlock(buffer);
    if (parsed !== undefined) yield parsed;
  }
}

function parseSseBlock(block: string): CodexResponsesSseMessage | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return event === undefined
    ? Object.freeze({ data: data.join('\n') })
    : Object.freeze({ event, data: data.join('\n') });
}

function parseProviderEvent(
  message: CodexResponsesSseMessage,
): Readonly<Record<string, unknown>> | undefined {
  if (message.data === '[DONE]') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message.data);
  } catch {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex response contained invalid event data.',
    );
  }
  if (!isRecord(value)) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex response event must be an object.',
    );
  }
  return value;
}

function eventType(
  event: Readonly<Record<string, unknown>>,
  message: CodexResponsesSseMessage,
): string {
  const value = event.type ?? message.event;
  if (typeof value !== 'string' || value === '') {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex response event is missing its type.',
    );
  }
  return value;
}

function callKey(
  event: Readonly<Record<string, unknown>>,
  item?: Readonly<Record<string, unknown>>,
) {
  const value = event.output_index ?? event.item_id ?? item?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function updateCall(call: PendingCall, item: Readonly<Record<string, unknown>>): void {
  if (typeof item.call_id === 'string') call.id = item.call_id;
  if (typeof item.name === 'string') call.operation = item.name;
  if (typeof item.arguments === 'string') call.arguments = item.arguments;
}

function emitCall(
  call: PendingCall,
  providerOperations: ReadonlyMap<string, string>,
): CodexModelEvent {
  if (call.id === undefined || call.operation === undefined) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex tool call is missing an id or operation.',
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(call.arguments || '{}');
  } catch {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex tool call arguments are not valid JSON.',
    );
  }
  if (!isRecord(input)) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex tool call arguments must be an object.',
    );
  }
  call.emitted = true;
  return {
    type: 'tool-call',
    call: {
      id: call.id,
      operation: providerOperations.get(call.operation) ?? call.operation,
      input: input as JsonObject,
    },
  };
}

function providerFailure(): CodexExperimentalModelError {
  return new CodexExperimentalModelError(
    'PROVIDER_ERROR',
    'Experimental Codex provider reported a response failure.',
  );
}

async function* decodeEvents(
  body: AsyncIterable<string>,
  context: OperationContext | undefined,
  providerOperations: ReadonlyMap<string, string>,
): AsyncIterable<CodexModelEvent> {
  const calls = new Map<string, PendingCall>();
  let completed = false;
  for await (const message of parseCodexResponsesSse(body)) {
    context?.signal?.throwIfCancelled();
    const event = parseProviderEvent(message);
    if (event === undefined) continue;
    const type = eventType(event, message);
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      throw providerFailure();
    }
    if (type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') {
        throw new CodexExperimentalModelError(
          'MALFORMED_RESPONSE',
          'Experimental Codex text delta must be a string.',
        );
      }
      yield { type: 'text', text: event.delta };
      continue;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    const key = callKey(event, item);
    if (type === 'response.output_item.added' && item?.type === 'function_call') {
      if (key === undefined) throw providerFailure();
      const call: PendingCall = { key, arguments: '', emitted: false };
      updateCall(call, item);
      calls.set(key, call);
      continue;
    }
    if (type === 'response.function_call_arguments.delta') {
      if (key === undefined || typeof event.delta !== 'string') throw providerFailure();
      const call = calls.get(key);
      if (call === undefined) throw providerFailure();
      call.arguments += event.delta;
      continue;
    }
    if (type === 'response.function_call_arguments.done') {
      if (key === undefined || typeof event.arguments !== 'string') throw providerFailure();
      const call = calls.get(key);
      if (call === undefined) throw providerFailure();
      call.arguments = event.arguments;
      continue;
    }
    if (type === 'response.output_item.done' && item?.type === 'function_call') {
      if (key === undefined) throw providerFailure();
      const call = calls.get(key) ?? { key, arguments: '', emitted: false };
      updateCall(call, item);
      if (!call.emitted) yield emitCall(call, providerOperations);
      calls.set(key, call);
      continue;
    }
    if (type === 'response.completed') {
      for (const call of calls.values()) {
        if (!call.emitted) yield emitCall(call, providerOperations);
      }
      completed = true;
      yield { type: 'completed' };
    }
  }
  context?.signal?.throwIfCancelled();
  if (!completed) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex response ended before completion.',
    );
  }
}

export async function* decodeCodexResponsesEvents(
  body: AsyncIterable<string>,
  context?: OperationContext,
  providerOperations: ReadonlyMap<string, string> = new Map(),
): AsyncIterable<CodexModelEvent> {
  try {
    yield* decodeEvents(body, context, providerOperations);
  } catch (error) {
    if (error instanceof CodexExperimentalModelError) throw error;
    context?.signal?.throwIfCancelled();
    throw new CodexExperimentalModelError(
      'TRANSPORT_FAILED',
      'Experimental Codex response stream failed.',
    );
  }
}

export function createCodexExperimentalModel(
  options: CreateCodexExperimentalModelOptions,
): CodexModel {
  const validated = validateOptions(options);
  return Object.freeze({
    async *generate(request: CodexModelRequest, context?: OperationContext) {
      context?.signal?.throwIfCancelled();
      const aliases = operationAliases(request);
      const body = JSON.stringify(createCodexResponsesRequestBody(request, validated.model));
      if (validated.kind === 'brokered') {
        const brokeredRequest: CodexResponsesRequest = {
          body,
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        };
        const response = await sendRequest(
          validated.send,
          Object.freeze(brokeredRequest),
          context?.signal,
        );
        if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
          throw new CodexExperimentalModelError(
            'HTTP_ERROR',
            'Experimental Codex request was rejected.',
            { status: response.status },
          );
        }
        yield* decodeCodexResponsesEvents(response.body, context, aliases.byProviderName);
        return;
      }
      const token = await accessToken(validated);
      context?.signal?.throwIfCancelled();
      const selectedAccountId = await accountId(validated);
      context?.signal?.throwIfCancelled();
      const headers: Record<string, string> = {
        ...validated.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        originator: validated.originator,
      };
      if (selectedAccountId !== undefined) headers['ChatGPT-Account-ID'] = selectedAccountId;
      const httpRequest: CodexResponsesHttpRequest = {
        method: 'POST',
        url: validated.endpoint,
        headers: Object.freeze(headers),
        body,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      };
      const response = await sendRequest(
        validated.send,
        Object.freeze(httpRequest),
        context?.signal,
      );
      if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        throw new CodexExperimentalModelError(
          'HTTP_ERROR',
          'Experimental Codex request was rejected.',
          { status: response.status },
        );
      }
      yield* decodeCodexResponsesEvents(response.body, context, aliases.byProviderName);
    },
  });
}
