import type { Agent, AgentDependencies, AgentFactory, OperationContext } from '@loom/plugin-api';
import {
  WORKSPACE_OPERATIONS,
  type WorkspaceOperation,
  type WorkspaceTool,
} from '@loom/tool-workspace';
import { immutableJson, type DeepReadonly, type JsonObject, type JsonValue } from '@loom/types';

import { CodexAgentError } from './errors.js';
import type {
  CodexAgentEvent,
  CodexAssistantMessage,
  CodexAssistantToolCall,
  CodexModel,
  CodexModelMessage,
  CodexModelRequest,
  CodexModelToolDefinition,
  CodexToolMessage,
} from './protocol.js';

export const DEFAULT_CODEX_MAX_TURNS = 8;
export const DEFAULT_CODEX_INSTRUCTIONS =
  'Complete the request accurately, using workspace tools when needed.';

export interface CodexAgentRequest {
  readonly prompt: string;
}

export interface CodexAgentConfiguration {
  readonly maxTurns?: number;
  readonly instructions?: string;
}

export interface CodexAgentDependencies extends AgentDependencies<CodexModel, WorkspaceTool> {
  readonly configuration: DeepReadonly<JsonObject> & CodexAgentConfiguration;
}

export type CodexAgent = Agent<CodexAgentRequest, CodexAgentEvent>;
export type CodexAgentFactory = AgentFactory<
  CodexAgentRequest,
  CodexAgentEvent,
  CodexAgentDependencies
>;

type WorkspaceToolSet = ReadonlyMap<WorkspaceOperation, WorkspaceTool>;

interface ValidatedConfiguration {
  readonly maxTurns: number;
  readonly instructions: string;
}

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.listFiles,
    description: 'List immediate files and directories at a workspace path.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    }) as JsonObject,
    outputSchema: immutableJson({
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              kind: { type: 'string', enum: ['file', 'directory'] },
            },
            required: ['path', 'kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['entries'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct', 'programmatic'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.readFile,
    description: 'Read a UTF-8 text file from the workspace.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }) as JsonObject,
    outputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct', 'programmatic'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.writeFile,
    description: 'Create or replace a UTF-8 text file in the workspace.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    }) as JsonObject,
    outputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, created: { type: 'boolean' } },
      required: ['path', 'created'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.stat,
    description: 'Inspect the type, byte size, and modification time of a workspace entry.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct', 'programmatic'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.createDirectory,
    description: 'Create a directory, optionally including missing parents.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.move,
    description: 'Move or rename a file or directory.',
    inputSchema: immutableJson({
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.remove,
    description: 'Remove a file or directory. Recursive removal must be explicitly requested.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct'] as const),
  }),
  Object.freeze({
    operation: WORKSPACE_OPERATIONS.applyPatch,
    description: 'Apply an exact-context unified diff to one UTF-8 workspace file.',
    inputSchema: immutableJson({
      type: 'object',
      properties: { path: { type: 'string' }, patch: { type: 'string' } },
      required: ['path', 'patch'],
      additionalProperties: false,
    }) as JsonObject,
    allowedCallers: Object.freeze(['direct'] as const),
  }),
] satisfies readonly CodexModelToolDefinition[]);

const AGENT_OPERATIONS = new Set<WorkspaceOperation>(
  TOOL_DEFINITIONS.map((definition) => definition.operation),
);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  errorCode:
    'INVALID_REQUEST' | 'INVALID_CONFIGURATION' | 'MALFORMED_MODEL_EVENT' | 'MALFORMED_TOOL_CALL',
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new CodexAgentError(errorCode, `${label} contains unsupported property '${key}'.`, {
        details: { property: key },
      });
    }
  }
}

function isWorkspaceOperation(value: string): value is WorkspaceOperation {
  return AGENT_OPERATIONS.has(value as WorkspaceOperation);
}

function validateConfiguration(configuration: DeepReadonly<JsonObject>): ValidatedConfiguration {
  exactKeys(
    configuration,
    ['maxTurns', 'instructions'],
    'INVALID_CONFIGURATION',
    'Codex agent configuration',
  );
  const maxTurns = configuration.maxTurns ?? DEFAULT_CODEX_MAX_TURNS;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new CodexAgentError(
      'INVALID_CONFIGURATION',
      'Codex agent configuration maxTurns must be a positive integer.',
      { details: { maxTurns } },
    );
  }
  const instructions = configuration.instructions ?? DEFAULT_CODEX_INSTRUCTIONS;
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    throw new CodexAgentError(
      'INVALID_CONFIGURATION',
      'Codex agent configuration instructions must be a non-empty string.',
      { details: { instructions } },
    );
  }
  return Object.freeze({ maxTurns, instructions });
}

function validateTools(tools: readonly WorkspaceTool[]): WorkspaceToolSet {
  const found = new Map<WorkspaceOperation, WorkspaceTool>();
  for (const candidate of tools as readonly unknown[]) {
    if (!isRecord(candidate) || typeof candidate.operation !== 'string') {
      throw new CodexAgentError(
        'INVALID_DEPENDENCIES',
        'Every Codex agent tool must declare a workspace operation.',
      );
    }
    if (!isWorkspaceOperation(candidate.operation)) {
      throw new CodexAgentError(
        'INVALID_DEPENDENCIES',
        `Unsupported Codex agent tool operation '${candidate.operation}'.`,
        { details: { operation: candidate.operation } },
      );
    }
    if (typeof candidate.execute !== 'function') {
      throw new CodexAgentError(
        'INVALID_DEPENDENCIES',
        `Workspace tool '${candidate.operation}' must implement execute().`,
      );
    }

    if (found.has(candidate.operation)) {
      throw new CodexAgentError(
        'INVALID_DEPENDENCIES',
        `Duplicate Codex agent tool for operation '${candidate.operation}'.`,
        { details: { operation: candidate.operation } },
      );
    }
    found.set(candidate.operation, candidate as unknown as WorkspaceTool);
  }

  for (const operation of [
    WORKSPACE_OPERATIONS.listFiles,
    WORKSPACE_OPERATIONS.readFile,
    WORKSPACE_OPERATIONS.writeFile,
  ] as const) {
    if (!found.has(operation)) {
      throw new CodexAgentError(
        'INVALID_DEPENDENCIES',
        `Missing Codex agent tool for operation '${operation}'.`,
        { details: { operation } },
      );
    }
  }

  return found;
}

function validateDependencies(dependencies: CodexAgentDependencies): {
  readonly model: CodexModel;
  readonly tools: WorkspaceToolSet;
  readonly maxTurns: number;
  readonly instructions: string;
} {
  if (
    !isRecord(dependencies) ||
    !isRecord(dependencies.model) ||
    typeof dependencies.model.generate !== 'function' ||
    !Array.isArray(dependencies.tools) ||
    !isRecord(dependencies.configuration)
  ) {
    throw new CodexAgentError(
      'INVALID_DEPENDENCIES',
      'Codex agent dependencies require a model, tools, and configuration.',
    );
  }
  const configuration = validateConfiguration(dependencies.configuration);
  return Object.freeze({
    model: dependencies.model,
    tools: validateTools(dependencies.tools),
    maxTurns: configuration.maxTurns,
    instructions: configuration.instructions,
  });
}

function validateRequest(request: CodexAgentRequest): string {
  if (!isRecord(request) || typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new CodexAgentError('INVALID_REQUEST', 'Codex agent request prompt must be non-empty.');
  }
  exactKeys(request, ['prompt'], 'INVALID_REQUEST', 'Codex agent request');
  return request.prompt;
}

function normalizedToolCall(record: Readonly<Record<string, unknown>>): CodexAssistantToolCall {
  exactKeys(
    record,
    ['id', 'operation', 'input', 'caller'],
    'MALFORMED_TOOL_CALL',
    'Model tool call',
  );
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new CodexAgentError('MALFORMED_TOOL_CALL', 'Model tool call requires a non-empty id.');
  }
  if (typeof record.operation !== 'string') {
    throw new CodexAgentError(
      'MALFORMED_TOOL_CALL',
      'Model tool call requires a string operation.',
    );
  }
  if (!isWorkspaceOperation(record.operation)) {
    throw new CodexAgentError(
      'UNKNOWN_TOOL_OPERATION',
      `Model requested unknown tool operation '${record.operation}'.`,
      { details: { operation: record.operation } },
    );
  }

  let input: JsonValue;
  try {
    input = immutableJson(record.input);
  } catch (error) {
    throw new CodexAgentError('MALFORMED_TOOL_CALL', 'Model tool call input must be JSON.', {
      cause: error,
    });
  }
  if (!isRecord(input)) {
    throw new CodexAgentError('MALFORMED_TOOL_CALL', 'Model tool call input must be an object.');
  }
  let caller: JsonObject | undefined;
  if (record.caller !== undefined) {
    let candidate: JsonValue;
    try {
      candidate = immutableJson(record.caller);
    } catch (error) {
      throw new CodexAgentError('MALFORMED_TOOL_CALL', 'Model tool caller must be JSON.', {
        cause: error,
      });
    }
    if (
      !isRecord(candidate) ||
      candidate.type !== 'program' ||
      typeof candidate.caller_id !== 'string' ||
      candidate.caller_id.trim() === ''
    ) {
      throw new CodexAgentError(
        'MALFORMED_TOOL_CALL',
        'Model tool caller must identify a hosted program.',
      );
    }
    if (
      record.operation !== WORKSPACE_OPERATIONS.listFiles &&
      record.operation !== WORKSPACE_OPERATIONS.readFile &&
      record.operation !== WORKSPACE_OPERATIONS.stat
    ) {
      throw new CodexAgentError(
        'UNAUTHORIZED_TOOL_CALL',
        'Hosted programs cannot invoke mutating workspace operations.',
        { details: { operation: record.operation } },
      );
    }
    caller = candidate;
  }
  return Object.freeze({
    id: record.id,
    operation: record.operation,
    input,
    ...(caller === undefined ? {} : { caller }),
  });
}

function normalizedModelEvent(
  value: unknown,
):
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: CodexAssistantToolCall }
  | { readonly type: 'continuation'; readonly item: JsonObject }
  | { readonly type: 'completed'; readonly final: boolean } {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new CodexAgentError('MALFORMED_MODEL_EVENT', 'Model emitted a malformed event.');
  }
  if (value.type === 'text') {
    exactKeys(value, ['type', 'text'], 'MALFORMED_MODEL_EVENT', 'Model text event');
    if (typeof value.text !== 'string') {
      throw new CodexAgentError('MALFORMED_MODEL_EVENT', 'Model text event requires text.');
    }
    return Object.freeze({ type: 'text', text: value.text });
  }
  if (value.type === 'tool-call') {
    exactKeys(value, ['type', 'call'], 'MALFORMED_MODEL_EVENT', 'Model tool-call event');
    if (!isRecord(value.call)) {
      throw new CodexAgentError('MALFORMED_TOOL_CALL', 'Model tool-call event requires a call.');
    }
    return Object.freeze({ type: 'tool-call', call: normalizedToolCall(value.call) });
  }
  if (value.type === 'continuation') {
    exactKeys(value, ['type', 'item'], 'MALFORMED_MODEL_EVENT', 'Model continuation event');
    let item: JsonValue;
    try {
      item = immutableJson(value.item);
    } catch (error) {
      throw new CodexAgentError('MALFORMED_MODEL_EVENT', 'Continuation item must be JSON.', {
        cause: error,
      });
    }
    if (!isRecord(item)) {
      throw new CodexAgentError('MALFORMED_MODEL_EVENT', 'Continuation item must be an object.');
    }
    return Object.freeze({ type: 'continuation', item });
  }
  if (value.type === 'completed') {
    exactKeys(value, ['type', 'final'], 'MALFORMED_MODEL_EVENT', 'Model completed event');
    if (value.final !== undefined && typeof value.final !== 'boolean') {
      throw new CodexAgentError(
        'MALFORMED_MODEL_EVENT',
        'Model completed event final must be boolean when provided.',
      );
    }
    return Object.freeze({ type: 'completed', final: value.final ?? true });
  }
  throw new CodexAgentError('UNKNOWN_MODEL_EVENT', `Unknown model event type '${value.type}'.`, {
    details: { type: value.type },
  });
}

async function executeTool(
  tools: WorkspaceToolSet,
  call: CodexAssistantToolCall,
  context?: OperationContext,
): Promise<JsonValue> {
  let output: unknown;
  try {
    const tool = tools.get(call.operation);
    if (tool === undefined) {
      throw new CodexAgentError(
        'UNKNOWN_TOOL_OPERATION',
        `No workspace tool is available for '${call.operation}'.`,
      );
    }
    output = await (
      tool.execute as (input: JsonObject, operationContext?: OperationContext) => Promise<unknown>
    )(call.input, context);
    context?.signal?.throwIfCancelled();
    return immutableJson(output);
  } catch (error) {
    context?.signal?.throwIfCancelled();
    const message = error instanceof Error ? error.message : 'The workspace tool failed.';
    return immutableJson({
      ok: false,
      error: {
        code: 'TOOL_FAILURE',
        message,
        operation: call.operation,
      },
    });
  }
}

function modelRequest(
  messages: readonly CodexModelMessage[],
  instructions: string,
  tools: WorkspaceToolSet,
): CodexModelRequest {
  return Object.freeze({
    instructions,
    messages: Object.freeze([...messages]),
    tools: Object.freeze(TOOL_DEFINITIONS.filter((definition) => tools.has(definition.operation))),
  });
}

function createAgent(bindings: ReturnType<typeof validateDependencies>): CodexAgent {
  return Object.freeze({
    async *run(
      request: CodexAgentRequest,
      context?: OperationContext,
    ): AsyncIterable<CodexAgentEvent> {
      const prompt = validateRequest(request);
      const history: CodexModelMessage[] = [Object.freeze({ role: 'user', content: prompt })];
      const seenCallIds = new Set<string>();

      for (let turn = 1; turn <= bindings.maxTurns; turn += 1) {
        context?.signal?.throwIfCancelled();
        let completed = false;
        let final = true;
        let text = '';
        const calls: CodexAssistantToolCall[] = [];
        const continuationItems: JsonObject[] = [];
        try {
          const stream = bindings.model.generate(
            modelRequest(history, bindings.instructions, bindings.tools),
            context,
          );
          for await (const rawEvent of stream as AsyncIterable<unknown>) {
            context?.signal?.throwIfCancelled();
            const event = normalizedModelEvent(rawEvent);
            if (event.type === 'completed') {
              completed = true;
              final = event.final;
              break;
            }
            if (event.type === 'text') {
              text += event.text;
              yield Object.freeze({ type: 'text', text: event.text });
              continue;
            }
            if (event.type === 'continuation') {
              continuationItems.push(event.item);
              continue;
            }
            if (seenCallIds.has(event.call.id)) {
              throw new CodexAgentError(
                'MALFORMED_TOOL_CALL',
                `Model reused tool call id '${event.call.id}'.`,
                { details: { callId: event.call.id } },
              );
            }
            seenCallIds.add(event.call.id);
            calls.push(event.call);
          }
        } catch (error) {
          context?.signal?.throwIfCancelled();
          if (error instanceof CodexAgentError) throw error;
          throw new CodexAgentError('MODEL_FAILURE', `Model failed during turn ${String(turn)}.`, {
            cause: error,
            details: { turn },
          });
        }

        if (!completed) {
          throw new CodexAgentError(
            'MALFORMED_MODEL_EVENT',
            `Model turn ${String(turn)} ended without a completed event.`,
            { details: { turn } },
          );
        }
        context?.signal?.throwIfCancelled();

        const assistantMessage: CodexAssistantMessage = Object.freeze({
          role: 'assistant',
          content: text,
          toolCalls: Object.freeze([...calls]),
          continuationItems: Object.freeze([...continuationItems]),
        });
        history.push(assistantMessage);

        if (calls.length === 0) {
          if (!final) continue;
          yield Object.freeze({ type: 'completed', turns: turn });
          return;
        }

        let callIndex = 0;
        while (callIndex < calls.length) {
          const call = calls[callIndex];
          if (call === undefined) break;
          if (call.caller !== undefined) {
            const batch: CodexAssistantToolCall[] = [];
            while (callIndex < calls.length) {
              const candidate = calls[callIndex];
              if (candidate?.caller === undefined) break;
              batch.push(candidate);
              callIndex += 1;
            }
            for (const nestedCall of batch) {
              const nestedCaller = nestedCall.caller;
              if (nestedCaller === undefined) {
                throw new CodexAgentError(
                  'MALFORMED_TOOL_CALL',
                  `Nested tool call '${nestedCall.id}' is missing caller metadata.`,
                );
              }
              yield Object.freeze({
                type: 'tool-start',
                callId: nestedCall.id,
                operation: nestedCall.operation,
                input: nestedCall.input,
                caller: nestedCaller,
              });
            }
            const results = await Promise.all(
              batch.map((nestedCall) => executeTool(bindings.tools, nestedCall, context)),
            );
            for (const [index, nestedCall] of batch.entries()) {
              const result = results[index];
              if (result === undefined) {
                throw new CodexAgentError(
                  'TOOL_FAILURE',
                  `Workspace tool '${nestedCall.operation}' returned no result for call '${nestedCall.id}'.`,
                );
              }
              const nestedCaller = nestedCall.caller;
              if (nestedCaller === undefined) {
                throw new CodexAgentError(
                  'MALFORMED_TOOL_CALL',
                  `Nested tool call '${nestedCall.id}' is missing caller metadata.`,
                );
              }
              const toolMessage: CodexToolMessage = Object.freeze({
                role: 'tool',
                callId: nestedCall.id,
                operation: nestedCall.operation,
                result,
                caller: nestedCaller,
              });
              history.push(toolMessage);
              yield Object.freeze({
                type: 'tool-finish',
                callId: nestedCall.id,
                operation: nestedCall.operation,
                result,
                caller: nestedCaller,
              });
            }
            continue;
          }
          context?.signal?.throwIfCancelled();
          yield Object.freeze({
            type: 'tool-start',
            callId: call.id,
            operation: call.operation,
            input: call.input,
          });
          const result = await executeTool(bindings.tools, call, context);
          const toolMessage: CodexToolMessage = Object.freeze({
            role: 'tool',
            callId: call.id,
            operation: call.operation,
            result,
          });
          history.push(toolMessage);
          yield Object.freeze({
            type: 'tool-finish',
            callId: call.id,
            operation: call.operation,
            result,
          });
          callIndex += 1;
        }
      }

      throw new CodexAgentError(
        'MAX_TURNS_EXCEEDED',
        `Codex agent exceeded its maximum of ${String(bindings.maxTurns)} turns.`,
        { details: { maxTurns: bindings.maxTurns } },
      );
    },
  });
}

export function createCodexAgentFactory(): CodexAgentFactory {
  return Object.freeze({
    create(dependencies: CodexAgentDependencies): CodexAgent {
      return createAgent(validateDependencies(dependencies));
    },
  });
}

export const CODEX_AGENT_FACTORY: CodexAgentFactory = createCodexAgentFactory();
