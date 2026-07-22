import type {
  CodexModel,
  CodexModelEvent,
  CodexModelMessage,
  CodexModelRequest,
} from '@mgravey/loom-agent-codex';
import type { OperationContext } from '@mgravey/loom-plugin-api';
import { immutableJson, type JsonObject, type JsonValue } from '@mgravey/loom-types';

import {
  OPENAI_RESPONSES_ENDPOINT,
  type CreateOpenAIResponsesModelOptions,
  type OpenAIApiKeySupplier,
  type OpenAIReasoningEffort,
  type OpenAIResponsesFetch,
  type OpenAIResponsesHttpRequest,
  type OpenAIResponsesHttpResponse,
  type OpenAIResponsesRequest,
  type OpenAIResponsesTransport,
  type OpenAITextVerbosity,
} from './contracts.js';
import { OpenAIResponsesModelError } from './errors.js';

const DEFAULT_REASONING_EFFORT: OpenAIReasoningEffort = 'medium';
const DEFAULT_TEXT_VERBOSITY: OpenAITextVerbosity = 'low';
const PROGRAMMATIC_INSTRUCTIONS = `<tool_orchestration>
Use Programmatic Tool Calling only for bounded read-only workspace discovery with list and read
tools when calls have predictable data flow and code can reduce the intermediate results. Run
independent read-only calls concurrently when safe. Do not retry a failed call more than once.
Use direct tool calls for semantic judgment and every workspace write. Never invoke a write from a
hosted program. Preserve the evidence needed for the final answer.
</tool_orchestration>`;

interface ValidatedCommonOptions {
  readonly model: string;
  readonly programmaticToolCalling: boolean;
  readonly reasoningEffort: OpenAIReasoningEffort;
  readonly textVerbosity: OpenAITextVerbosity;
}

interface ValidatedTransportOptions extends ValidatedCommonOptions {
  readonly kind: 'transport';
  readonly send: OpenAIResponsesTransport['send'];
}

interface ValidatedDirectOptions extends ValidatedCommonOptions {
  readonly kind: 'direct';
  readonly endpoint: string;
  readonly getApiKey: OpenAIApiKeySupplier;
  readonly send: OpenAIResponsesFetch;
  readonly headers: Readonly<Record<string, string>>;
}

type ValidatedOptions = ValidatedTransportOptions | ValidatedDirectOptions;

interface OperationAliases {
  readonly byOperation: ReadonlyMap<string, string>;
  readonly byProviderName: ReadonlyMap<string, string>;
}

export interface OpenAIResponsesRequestBodyOptions {
  readonly programmaticToolCalling?: boolean;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  readonly textVerbosity?: OpenAITextVerbosity;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      `OpenAI Responses model ${label} must be a non-empty string.`,
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
        'OpenAI Responses headers must contain non-empty names and values.',
      );
    }
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'content-type') {
      throw new OpenAIResponsesModelError(
        'INVALID_CONFIGURATION',
        `OpenAI Responses header '${name}' is managed by the adapter.`,
      );
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function validateCommon(options: CreateOpenAIResponsesModelOptions): ValidatedCommonOptions {
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses reasoning effort is invalid.',
    );
  }
  const textVerbosity = options.textVerbosity ?? DEFAULT_TEXT_VERBOSITY;
  if (!['low', 'medium', 'high'].includes(textVerbosity)) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses text verbosity is invalid.',
    );
  }
  if (
    options.programmaticToolCalling !== undefined &&
    typeof options.programmaticToolCalling !== 'boolean'
  ) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses programmaticToolCalling must be boolean.',
    );
  }
  return Object.freeze({
    model: requiredString(options.model, 'model'),
    programmaticToolCalling: options.programmaticToolCalling ?? true,
    reasoningEffort,
    textVerbosity,
  });
}

function validateOptions(options: CreateOpenAIResponsesModelOptions): ValidatedOptions {
  if (!isRecord(options)) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses model options are required.',
    );
  }
  const hasTransport = 'transport' in options;
  const hasFetch = 'fetch' in options;
  if (hasTransport === hasFetch) {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses model requires exactly one secure transport or direct fetch adapter.',
    );
  }
  const common = validateCommon(options);
  if (hasTransport) {
    const transport = options.transport;
    if (!isRecord(transport) || typeof transport.send !== 'function') {
      throw new OpenAIResponsesModelError(
        'INVALID_CONFIGURATION',
        'OpenAI Responses model requires an injected secure transport.',
      );
    }
    return Object.freeze({
      ...common,
      kind: 'transport',
      send: (request: OpenAIResponsesRequest) =>
        (transport as unknown as OpenAIResponsesTransport).send(request),
    });
  }

  const direct = options as Extract<CreateOpenAIResponsesModelOptions, { readonly fetch: unknown }>;
  const authentication = direct.authentication;
  const getApiKey =
    typeof authentication === 'function'
      ? authentication
      : isRecord(authentication) && typeof authentication.getAccessToken === 'function'
        ? () => authentication.getAccessToken()
        : undefined;
  if (getApiKey === undefined || typeof direct.fetch !== 'function') {
    throw new OpenAIResponsesModelError(
      'INVALID_CONFIGURATION',
      'OpenAI Responses direct mode requires authentication and an injected fetch adapter.',
    );
  }
  return Object.freeze({
    ...common,
    kind: 'direct',
    endpoint: requiredString(direct.endpoint ?? OPENAI_RESPONSES_ENDPOINT, 'endpoint'),
    getApiKey,
    send: direct.fetch,
    headers: validateHeaders(direct.headers),
  });
}

function operationAliases(request: CodexModelRequest): OperationAliases {
  const byOperation = new Map<string, string>();
  const byProviderName = new Map<string, string>();
  const add = (operation: string): void => {
    const readable = operation.replaceAll(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 48);
    const providerName = `loom_${String(byOperation.size)}_${readable}`;
    byOperation.set(operation, providerName);
    byProviderName.set(providerName, operation);
  };
  for (const tool of request.tools) {
    if (byOperation.has(tool.operation)) {
      throw new OpenAIResponsesModelError(
        'INVALID_REQUEST',
        `OpenAI Responses model received duplicate tool operation '${tool.operation}'.`,
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
  const name = aliases.byOperation.get(operation);
  if (name === undefined) {
    throw new OpenAIResponsesModelError(
      'INVALID_REQUEST',
      `OpenAI Responses model received undeclared tool operation '${operation}'.`,
    );
  }
  return name;
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
        ...(message.caller === undefined ? {} : { caller: message.caller }),
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
      ...(call.caller === undefined ? {} : { caller: call.caller }),
    });
  }
  return items;
}

export function createOpenAIResponsesRequestBody(
  request: CodexModelRequest,
  model: string,
  options: OpenAIResponsesRequestBodyOptions = {},
): JsonObject {
  const candidate: unknown = request;
  if (
    !isRecord(candidate) ||
    typeof candidate.instructions !== 'string' ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.tools)
  ) {
    throw new OpenAIResponsesModelError(
      'INVALID_REQUEST',
      'OpenAI Responses model received an invalid agent request.',
    );
  }
  const aliases = operationAliases(request);
  const programmaticToolCalling = options.programmaticToolCalling ?? true;
  const functionTools: JsonObject[] = request.tools.map((tool) => {
    const allowedCallers = programmaticToolCalling
      ? (tool.allowedCallers ?? ['direct'])
      : (['direct'] as const);
    return {
      type: 'function',
      name: providerOperation(aliases, tool.operation),
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { output_schema: tool.outputSchema }),
      allowed_callers: allowedCallers,
      strict: false,
    };
  });
  const tools: JsonObject[] = programmaticToolCalling
    ? [...functionTools, { type: 'programmatic_tool_calling' }]
    : functionTools;
  return {
    model: requiredString(model, 'model'),
    instructions: programmaticToolCalling
      ? `${request.instructions}\n\n${PROGRAMMATIC_INSTRUCTIONS}`
      : request.instructions,
    input: request.messages.flatMap((message) => encodeMessage(message, aliases)),
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: false,
    reasoning: { effort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT },
    store: false,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: options.textVerbosity ?? DEFAULT_TEXT_VERBOSITY },
  };
}

async function sendRequest<Request extends OpenAIResponsesRequest | OpenAIResponsesHttpRequest>(
  send: (request: Request) => Promise<OpenAIResponsesHttpResponse>,
  request: Request,
  context?: OperationContext,
): Promise<OpenAIResponsesHttpResponse> {
  try {
    const response: unknown = await send(request);
    context?.signal?.throwIfCancelled();
    if (
      !isRecord(response) ||
      typeof response.status !== 'number' ||
      !Number.isInteger(response.status) ||
      typeof response.body !== 'string'
    ) {
      throw new Error('invalid response');
    }
    return response as unknown as OpenAIResponsesHttpResponse;
  } catch (error) {
    if (error instanceof OpenAIResponsesModelError) throw error;
    context?.signal?.throwIfCancelled();
    throw new OpenAIResponsesModelError('TRANSPORT_FAILED', 'OpenAI Responses transport failed.');
  }
}

function parseResponse(body: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses transport returned invalid JSON.',
    );
  }
  if (!isRecord(value)) {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses transport returned a non-object response.',
    );
  }
  if (value.status !== 'completed') {
    if (value.status === 'incomplete') {
      throw new OpenAIResponsesModelError(
        'INCOMPLETE_RESPONSE',
        'OpenAI Responses request ended incomplete.',
      );
    }
    throw new OpenAIResponsesModelError(
      'PROVIDER_ERROR',
      'OpenAI Responses provider reported a response failure.',
    );
  }
  if (!Array.isArray(value.output)) {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses response is missing its output items.',
    );
  }
  return value;
}

function normalizedItem(value: unknown): JsonObject {
  let item: JsonValue;
  try {
    item = immutableJson(value);
  } catch {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses output item must be JSON.',
    );
  }
  if (!isRecord(item)) {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses output item must be an object.',
    );
  }
  return item;
}

function messageText(item: Readonly<Record<string, unknown>>): string {
  if (!Array.isArray(item.content)) {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses message item is missing content.',
    );
  }
  let text = '';
  for (const part of item.content) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      throw new OpenAIResponsesModelError(
        'MALFORMED_RESPONSE',
        'OpenAI Responses message contains a malformed content part.',
      );
    }
    if (part.type === 'output_text') {
      if (typeof part.text !== 'string') {
        throw new OpenAIResponsesModelError(
          'MALFORMED_RESPONSE',
          'OpenAI Responses output text must be a string.',
        );
      }
      text += part.text;
    }
    if (part.type === 'refusal') {
      if (typeof part.refusal !== 'string') {
        throw new OpenAIResponsesModelError(
          'MALFORMED_RESPONSE',
          'OpenAI Responses refusal must be a string.',
        );
      }
      text += part.refusal;
    }
  }
  return text;
}

function functionCall(
  item: Readonly<Record<string, unknown>>,
  aliases: OperationAliases,
): CodexModelEvent {
  if (
    typeof item.call_id !== 'string' ||
    item.call_id.trim() === '' ||
    typeof item.name !== 'string' ||
    typeof item.arguments !== 'string'
  ) {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses function call is missing required fields.',
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(item.arguments);
  } catch {
    throw new OpenAIResponsesModelError(
      'MALFORMED_RESPONSE',
      'OpenAI Responses function arguments are invalid JSON.',
    );
  }
  const normalizedInput = normalizedItem(input);
  const caller = item.caller === undefined ? undefined : normalizedItem(item.caller);
  return {
    type: 'tool-call',
    call: {
      id: item.call_id,
      operation: aliases.byProviderName.get(item.name) ?? item.name,
      input: normalizedInput,
      ...(caller === undefined ? {} : { caller }),
    },
  };
}

export async function* decodeOpenAIResponses(
  body: string,
  request: CodexModelRequest,
  context?: OperationContext,
): AsyncIterable<CodexModelEvent> {
  await Promise.resolve();
  const response = parseResponse(body);
  const aliases = operationAliases(request);
  const output = response.output as readonly unknown[];
  let final = false;
  for (const rawItem of output) {
    context?.signal?.throwIfCancelled();
    const item = normalizedItem(rawItem);
    yield { type: 'continuation', item };
    if (item.type === 'function_call') yield functionCall(item, aliases);
    if (item.type === 'message') {
      final = true;
      const text = messageText(item);
      if (text !== '') yield { type: 'text', text };
    }
  }
  yield { type: 'completed', final };
}

async function apiKey(options: ValidatedDirectOptions): Promise<string> {
  try {
    const value = await options.getApiKey();
    if (typeof value !== 'string' || value.trim() === '') throw new Error('invalid key');
    return value;
  } catch {
    throw new OpenAIResponsesModelError(
      'AUTHENTICATION_FAILED',
      'OpenAI Responses authentication failed.',
    );
  }
}

export function createOpenAIResponsesModel(options: CreateOpenAIResponsesModelOptions): CodexModel {
  const validated = validateOptions(options);
  return Object.freeze({
    async *generate(request: CodexModelRequest, context?: OperationContext) {
      context?.signal?.throwIfCancelled();
      const body = JSON.stringify(
        createOpenAIResponsesRequestBody(request, validated.model, validated),
      );
      let response: OpenAIResponsesHttpResponse;
      if (validated.kind === 'transport') {
        const transportRequest: OpenAIResponsesRequest = {
          body,
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        };
        response = await sendRequest(validated.send, Object.freeze(transportRequest), context);
      } else {
        const key = await apiKey(validated);
        context?.signal?.throwIfCancelled();
        const httpRequest: OpenAIResponsesHttpRequest = {
          method: 'POST',
          url: validated.endpoint,
          headers: Object.freeze({
            ...validated.headers,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          }),
          body,
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        };
        response = await sendRequest(validated.send, Object.freeze(httpRequest), context);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new OpenAIResponsesModelError(
          'HTTP_ERROR',
          'OpenAI Responses request was rejected.',
          { status: response.status },
        );
      }
      yield* decodeOpenAIResponses(response.body, request, context);
    },
  });
}
