import type {
  CodexModelEvent,
  CodexModelMessage,
  CodexModelRequest,
} from '@mgravey/loom-agent-codex';
import type { OperationContext } from '@mgravey/loom-plugin-api';
import { immutableJson, type JsonObject, type JsonValue } from '@mgravey/loom-types';

import type {
  CodexReasoningEffort,
  AccessTokenSupplier,
  AccountIdSupplier,
  CodexExperimentalDirectFetchOptions,
  CodexExperimentalModel,
  CodexContextCompactionResult,
  CreateCodexExperimentalModelOptions,
  CodexResponsesFetch,
  CodexResponsesHttpRequest,
  CodexResponsesHttpResponse,
  CodexResponsesRequest,
  CodexResponsesSseMessage,
  CodexResponsesTransport,
  CodexResponsesWireProtocol,
} from './contracts.js';
import { CodexExperimentalModelError, type CodexProviderFailureDetails } from './errors.js';
import {
  boundedCodexProviderString,
  isCodexContextCompactionRequired,
  isRetryableProviderFailure,
  sanitizeCodexProviderMessage,
  validCodexRetryAfterMs,
} from './provider-failure.js';

import { compactWithBudget, retryDelay, transportFailure, waitForRetry } from './resilience.js';

const DEFAULT_ORIGINATOR = 'loom_js_experimental';
const MAXIMUM_COMPACTION_ITEMS = 2_000;
const MAXIMUM_COMPACTION_RESPONSE_CHARACTERS = 4 * 1024 * 1024;

interface ValidatedBrokeredOptions {
  readonly kind: 'brokered';
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly wireProtocol: CodexResponsesWireProtocol;
  readonly send: CodexResponsesTransport['send'];
}

interface ValidatedDirectOptions {
  readonly kind: 'direct';
  readonly endpoint: string;
  readonly compactEndpoint: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly wireProtocol: CodexResponsesWireProtocol;
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
  const reasoningEffort = options.reasoningEffort ?? 'medium';
  if (
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)
  ) {
    throw new CodexExperimentalModelError('INVALID_CONFIGURATION', 'Invalid reasoning effort.');
  }
  const wireProtocolCandidate: unknown = options.wireProtocol ?? 'classic';
  if (wireProtocolCandidate !== 'classic' && wireProtocolCandidate !== 'responses-lite') {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Experimental Codex model wireProtocol must be classic or responses-lite.',
    );
  }
  const wireProtocol = wireProtocolCandidate;
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
      reasoningEffort,
      wireProtocol,
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
  if (direct.compactEndpoint !== undefined && direct.compactEndpoint !== direct.endpoint) {
    throw new CodexExperimentalModelError(
      'INVALID_CONFIGURATION',
      'Codex compaction must use the generation endpoint.',
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
    compactEndpoint: requiredString(direct.compactEndpoint ?? direct.endpoint, 'compact endpoint'),
    model,
    reasoningEffort,
    wireProtocol,
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
    return [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] },
    ];
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
  if (message.continuationItems !== undefined && message.continuationItems.length > 0) {
    return message.continuationItems;
  }
  const items: JsonValue[] = [];
  if (message.content !== '') {
    items.push({
      type: 'message',
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

function validatedContextItems(request: CodexModelRequest): readonly JsonObject[] {
  if (request.contextItems === undefined) return Object.freeze([]);
  if (
    !Array.isArray(request.contextItems) ||
    request.contextItems.length > MAXIMUM_COMPACTION_ITEMS
  ) {
    throw new CodexExperimentalModelError(
      'INVALID_REQUEST',
      `Experimental Codex context must contain at most ${String(MAXIMUM_COMPACTION_ITEMS)} items.`,
    );
  }
  return Object.freeze(
    request.contextItems.map((candidate) => {
      let value: JsonValue;
      try {
        value = immutableJson(candidate);
      } catch {
        throw new CodexExperimentalModelError(
          'INVALID_REQUEST',
          'Experimental Codex context items must be JSON objects.',
        );
      }
      if (!isRecord(value)) {
        throw new CodexExperimentalModelError(
          'INVALID_REQUEST',
          'Experimental Codex context items must be JSON objects.',
        );
      }
      return value;
    }),
  );
}

export function createCodexResponsesRequestBody(
  request: CodexModelRequest,
  model: string,
  wireProtocol: CodexResponsesWireProtocol = 'classic',
  reasoningEffort: CodexReasoningEffort = 'medium',
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
  const tools = request.tools.map((tool) => ({
    type: 'function',
    name: providerOperation(aliases, tool.operation),
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
  const input = [
    ...validatedContextItems(request),
    ...request.messages.flatMap((message) => encodeMessage(message, aliases)),
  ];
  const common = {
    model,
    tool_choice: 'auto',
    parallel_tool_calls: wireProtocol !== 'responses-lite',
    reasoning:
      wireProtocol === 'responses-lite'
        ? { effort: reasoningEffort, context: 'all_turns' }
        : { effort: reasoningEffort },
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  };
  if (wireProtocol === 'responses-lite') {
    return {
      ...common,
      input: [
        { type: 'additional_tools', role: 'developer', tools },
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: request.instructions }],
        },
        ...input,
      ],
    };
  }
  return { ...common, instructions: request.instructions, input, tools };
}

export function createCodexCompactionRequestBody(
  request: CodexModelRequest,
  model: string,
  wireProtocol: CodexResponsesWireProtocol = 'classic',
  reasoningEffort: CodexReasoningEffort = 'medium',
): JsonObject {
  const body = createCodexResponsesRequestBody(request, model, wireProtocol, reasoningEffort);
  return {
    ...body,
    input: [...(body.input as readonly JsonValue[]), { type: 'compaction_trigger' }],
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
      throw new CodexExperimentalModelError('MALFORMED_RESPONSE', 'Invalid transport response.', {
        retryable: false,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof CodexExperimentalModelError) throw error;
    signal?.throwIfCancelled();
    throw transportFailure(
      error,
      (request as { operation?: 'generate' | 'compact' }).operation ?? 'generate',
      'request',
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

function continuationItem(item: Readonly<Record<string, unknown>>): JsonObject {
  let value: JsonValue;
  try {
    value = immutableJson(item);
  } catch {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex continuation item must be JSON.',
    );
  }
  if (!isRecord(value)) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Experimental Codex continuation item must be an object.',
    );
  }
  return value;
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

function validStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function providerFailure(
  details: CodexProviderFailureDetails = {},
  status?: number,
): CodexExperimentalModelError {
  const providerCode = boundedCodexProviderString(details.providerCode);
  const incompleteReason = boundedCodexProviderString(details.incompleteReason);
  const retryAfterMs = validCodexRetryAfterMs(details.retryAfterMs);
  return new CodexExperimentalModelError(
    'PROVIDER_ERROR',
    'Experimental Codex provider reported a response failure.',
    {
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(details.providerMessage === undefined
        ? {}
        : { providerMessage: sanitizeCodexProviderMessage(details.providerMessage) }),
      ...(incompleteReason === undefined ? {} : { incompleteReason }),
      retryable: isRetryableProviderFailure(status, providerCode),
      contextCompactionRequired: isCodexContextCompactionRequired(providerCode),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

function eventStatus(
  event: Readonly<Record<string, unknown>>,
  ...nested: readonly (Readonly<Record<string, unknown>> | undefined)[]
): number | undefined {
  return (
    validStatus(event.status) ??
    nested.map((value) => validStatus(value?.status)).find((value) => value !== undefined)
  );
}

function streamedProviderFailure(
  type: 'error' | 'response.failed' | 'response.incomplete',
  event: Readonly<Record<string, unknown>>,
): CodexExperimentalModelError {
  const response = isRecord(event.response) ? event.response : undefined;
  if (type === 'response.incomplete') {
    const details = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : isRecord(event.incomplete_details)
        ? event.incomplete_details
        : undefined;
    const incompleteReason = boundedCodexProviderString(
      details?.reason ?? response?.reason ?? event.reason,
    );
    return providerFailure(
      { ...(incompleteReason === undefined ? {} : { incompleteReason }) },
      eventStatus(event, response, details),
    );
  }

  const nestedError =
    (isRecord(response?.error) ? response.error : undefined) ??
    (isRecord(event.error) ? event.error : undefined);
  const source = nestedError ?? response ?? event;
  const providerCode = boundedCodexProviderString(source.code ?? event.code);
  return providerFailure(
    {
      ...(providerCode === undefined ? {} : { providerCode }),
      providerMessage: sanitizeCodexProviderMessage(source.message ?? event.message),
    },
    eventStatus(event, response, nestedError),
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
      throw streamedProviderFailure(type, event);
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
      yield { type: 'continuation', item: continuationItem(item) };
      if (!call.emitted) yield emitCall(call, providerOperations);
      calls.set(key, call);
      continue;
    }
    if (type === 'response.output_item.done' && item !== undefined) {
      yield { type: 'continuation', item: continuationItem(item) };
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
  metadata: CodexProviderFailureDetails & { readonly status?: number } = {},
): AsyncIterable<CodexModelEvent> {
  try {
    yield* decodeEvents(body, context, providerOperations);
  } catch (error) {
    context?.signal?.throwIfCancelled();
    const underlying = transportFailure(error, 'generate', 'stream');
    throw new CodexExperimentalModelError(underlying.code, underlying.message, {
      ...copiedFailureDetails(underlying),
      ...metadata,
      operation: 'generate',
      stage: 'stream',
    });
  }
}

function safeRequestId(value: unknown): { readonly requestId?: string } {
  const requestId = boundedCodexProviderString(value);
  return requestId === undefined ? {} : { requestId };
}

function copiedFailureDetails(
  error: CodexExperimentalModelError,
): CodexProviderFailureDetails & { readonly status?: number } {
  return Object.fromEntries(
    Object.entries({
      operation: error.operation,
      requestId: error.requestId,
      stage: error.stage,
      remoteCode: error.remoteCode,
      status: error.status,
      providerCode: error.providerCode,
      providerMessage: error.providerMessage,
      incompleteReason: error.incompleteReason,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      contextCompactionRequired: error.contextCompactionRequired,
      cause: error.cause,
    }).filter(([, value]) => value !== undefined),
  );
}

function httpFailureDetails(
  response: CodexResponsesHttpResponse,
): CodexProviderFailureDetails & { readonly status: number } {
  const providerCode = boundedCodexProviderString(response.providerCode);
  const providerMessage =
    response.providerMessage === undefined
      ? undefined
      : sanitizeCodexProviderMessage(response.providerMessage);
  const retryAfterMs = validCodexRetryAfterMs(response.retryAfterMs);
  return {
    status: response.status,
    ...safeRequestId(response.requestId),
    ...(response.operation === undefined ? {} : { operation: response.operation }),
    stage: 'provider',
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerMessage === undefined ? {} : { providerMessage }),
    retryable: isRetryableProviderFailure(response.status, providerCode),
    contextCompactionRequired: isCodexContextCompactionRequired(providerCode),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

async function decodeCompactionResponse(
  body: AsyncIterable<string>,
  requestBody: string,
  context?: OperationContext,
): Promise<CodexContextCompactionResult> {
  let characters = 0;
  async function* boundedBody() {
    for await (const chunk of body) {
      context?.signal?.throwIfCancelled();
      if (
        typeof chunk !== 'string' ||
        (characters += chunk.length) > MAXIMUM_COMPACTION_RESPONSE_CHARACTERS
      ) {
        throw new CodexExperimentalModelError(
          'MALFORMED_RESPONSE',
          'Invalid or oversized compaction stream.',
        );
      }
      yield chunk;
    }
  }
  const summaries: JsonObject[] = [];
  let completed = false;
  for await (const message of parseCodexResponsesSse(boundedBody())) {
    context?.signal?.throwIfCancelled();
    const event = parseProviderEvent(message);
    if (event === undefined) continue;
    const type = eventType(event, message);
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      throw streamedProviderFailure(type, event);
    }
    if (
      event.type === 'response.output_item.done' &&
      isRecord(event.item) &&
      (event.item.type === 'compaction' || event.item.type === 'compaction_summary')
    ) {
      if (
        typeof event.item.encrypted_content !== 'string' ||
        event.item.encrypted_content.length === 0
      ) {
        throw new CodexExperimentalModelError(
          'MALFORMED_RESPONSE',
          'Compaction output has no encrypted content.',
        );
      }
      summaries.push(continuationItem(event.item));
    }
    if (type === 'response.completed') {
      if (
        !isRecord(event.response) ||
        typeof event.response.id !== 'string' ||
        event.response.id.length === 0 ||
        event.response.status !== 'completed'
      ) {
        throw new CodexExperimentalModelError(
          'MALFORMED_RESPONSE',
          'Invalid compaction completion.',
        );
      }
      completed = true;
    }
  }
  context?.signal?.throwIfCancelled();
  if (!completed || summaries.length !== 1) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Compaction requires exactly one summary and a completed response.',
    );
  }
  const input = (JSON.parse(requestBody) as { input: JsonObject[] }).input;
  // The upstream v2 checkpoint retains user/client developer messages plus the opaque summary.
  // Loom retains all such messages without upstream's lossy token/image trimming.
  const retained = input.filter(
    (item, index) =>
      item.type === 'message' &&
      (item.role === 'user' || item.role === 'developer') &&
      !(index === 1 && input[0]?.type === 'additional_tools'),
  );
  const items = immutableJson([...retained, ...summaries]) as readonly JsonObject[];
  if (items.length > MAXIMUM_COMPACTION_ITEMS) {
    throw new CodexExperimentalModelError(
      'MALFORMED_RESPONSE',
      'Compaction checkpoint exceeds the item limit.',
    );
  }
  return Object.freeze({ items });
}

export function createCodexExperimentalModel(
  options: CreateCodexExperimentalModelOptions,
): CodexExperimentalModel {
  const validated = validateOptions(options);
  const compactOnce = async (
    request: CodexModelRequest,
    context?: OperationContext,
  ): Promise<CodexContextCompactionResult> => {
    context?.signal?.throwIfCancelled();
    const body = JSON.stringify(
      createCodexCompactionRequestBody(
        request,
        validated.model,
        validated.wireProtocol,
        validated.reasoningEffort,
      ),
    );
    let response: CodexResponsesHttpResponse;
    if (validated.kind === 'brokered') {
      const brokeredRequest: CodexResponsesRequest = {
        body,
        operation: 'compact',
        wireProtocol: validated.wireProtocol,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      };
      response = await sendRequest(validated.send, Object.freeze(brokeredRequest), context?.signal);
    } else {
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
      if (validated.wireProtocol === 'responses-lite') {
        headers['x-openai-internal-codex-responses-lite'] = 'true';
      }
      if (selectedAccountId !== undefined) headers['ChatGPT-Account-ID'] = selectedAccountId;
      const httpRequest: CodexResponsesHttpRequest = {
        method: 'POST',
        url: validated.compactEndpoint,
        operation: 'compact',
        headers: Object.freeze(headers),
        body,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      };
      response = await sendRequest(validated.send, Object.freeze(httpRequest), context?.signal);
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new CodexExperimentalModelError(
        response.status === 404 || response.status === 405 || response.status === 501
          ? 'COMPACTION_UNAVAILABLE'
          : response.status === 401 || response.status === 403
            ? 'AUTHENTICATION_FAILED'
            : 'HTTP_ERROR',
        'Codex compaction is unavailable; the original context is intact.',
        {
          ...httpFailureDetails(response),
          operation: 'compact',
          retryable:
            ![404, 405, 501].includes(response.status) &&
            isRetryableProviderFailure(response.status, response.providerCode),
        },
      );
    }
    try {
      return await decodeCompactionResponse(response.body, body, context);
    } catch (caught) {
      context?.signal?.throwIfCancelled();
      const error = transportFailure(caught, 'compact', 'stream');
      throw new CodexExperimentalModelError(error.code, error.message, {
        ...copiedFailureDetails(error),
        operation: 'compact',
        stage: 'stream',
        status: response.status,
        ...safeRequestId(response.requestId),
        retryable: false,
      });
    }
  };
  const timeoutMs = options.compactionTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new CodexExperimentalModelError('INVALID_CONFIGURATION', 'Invalid compaction timeout.');
  }
  // Per model/transport instance (and endpoint), further scoped by caller session. Bounded memory.
  const unavailable = new Map<string, { until: number; error: CodexExperimentalModelError }>();
  const compact = (
    request: CodexModelRequest,
    context?: OperationContext,
  ): Promise<CodexContextCompactionResult> =>
    compactWithBudget(
      async (activeContext) => {
        const key = context?.sessionId ?? 'default';
        const cached = unavailable.get(key);
        if (cached !== undefined && cached.until > Date.now()) throw cached.error;
        unavailable.delete(key);
        for (let attempt = 0; ; attempt += 1) {
          activeContext.signal?.throwIfCancelled();
          try {
            return await compactOnce(request, activeContext);
          } catch (caught) {
            activeContext.signal?.throwIfCancelled();
            const underlying = transportFailure(caught, 'compact', 'stream');
            const error = new CodexExperimentalModelError(underlying.code, underlying.message, {
              ...copiedFailureDetails(underlying),
              operation: 'compact',
              stage: underlying.stage ?? 'stream',
            });
            if (error.code === 'COMPACTION_UNAVAILABLE') {
              const oldest = unavailable.keys().next().value;
              if (unavailable.size >= 128 && oldest !== undefined) unavailable.delete(oldest);
              unavailable.set(key, { until: Date.now() + 300_000, error });
            }
            // Only failures before an accepted stream are replayed. No generation or tool replay.
            if (
              attempt >= 2 ||
              !error.retryable ||
              !(error.code === 'HTTP_ERROR' || error.remoteCode === 'PROVIDER_FETCH_FAILED')
            )
              throw error;
            await waitForRetry(retryDelay(error, attempt), activeContext);
          }
        }
      },
      context,
      timeoutMs,
    );
  return Object.freeze({
    resetCompactionAvailability() {
      unavailable.clear();
    },
    requestCharacters(request: CodexModelRequest) {
      return JSON.stringify(
        createCodexResponsesRequestBody(
          request,
          validated.model,
          validated.wireProtocol,
          validated.reasoningEffort,
        ),
      ).length;
    },
    compact,
    async *generate(request: CodexModelRequest, context?: OperationContext) {
      context?.signal?.throwIfCancelled();
      const aliases = operationAliases(request);
      const body = JSON.stringify(
        createCodexResponsesRequestBody(
          request,
          validated.model,
          validated.wireProtocol,
          validated.reasoningEffort,
        ),
      );
      if (validated.kind === 'brokered') {
        const brokeredRequest: CodexResponsesRequest = {
          body,
          operation: 'generate',
          wireProtocol: validated.wireProtocol,
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
            httpFailureDetails(response),
          );
        }
        yield* decodeCodexResponsesEvents(response.body, context, aliases.byProviderName, {
          ...safeRequestId(response.requestId),
          status: response.status,
          retryable: false,
        });
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
      if (validated.wireProtocol === 'responses-lite') {
        headers['x-openai-internal-codex-responses-lite'] = 'true';
      }
      if (selectedAccountId !== undefined) headers['ChatGPT-Account-ID'] = selectedAccountId;
      const httpRequest: CodexResponsesHttpRequest = {
        method: 'POST',
        url: validated.endpoint,
        operation: 'generate',
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
          httpFailureDetails(response),
        );
      }
      yield* decodeCodexResponsesEvents(response.body, context, aliases.byProviderName, {
        ...safeRequestId(response.requestId),
        status: response.status,
        retryable: false,
      });
    },
  });
}
