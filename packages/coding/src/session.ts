import {
  CODEX_AGENT_FACTORY,
  CodexAgentError,
  DEFAULT_CODEX_INSTRUCTIONS,
  type CodexAgentConfiguration,
  type CodexAgentEvent,
  type CodexAgentTool,
  type CodexAgent,
  type CodexModel,
  type CodexModelRequest,
} from '@mgravey/loom-agent-codex';
import type { ExecutionRuntime, OperationContext } from '@mgravey/loom-plugin-api';
import {
  createCancellationSource,
  immutableJson,
  sessionId,
  type CancellationSource,
  type DeepReadonly,
  type JsonObject,
  type JsonValue,
  type SessionId,
} from '@mgravey/loom-types';

export type CodingSessionState = 'idle' | 'running' | 'disposed';

export interface CodingTranscriptEntry {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface CodingSessionStateEvent {
  readonly type: 'state';
  readonly state: CodingSessionState;
}

export interface CodingSessionAgentEvent {
  readonly type: 'agent';
  readonly event: CodexAgentEvent;
}

export interface CodingSessionTranscriptEvent {
  readonly type: 'transcript';
  readonly entry: CodingTranscriptEntry;
}

export interface CodingContextCheckpoint {
  /** Opaque model-native context. Persist and replay it without inspecting its content. */
  readonly items: readonly JsonObject[];
  /** Number of leading transcript entries represented by `items`. */
  readonly coveredTranscriptEntries: number;
}

export interface CodingSessionContextCompactedEvent {
  readonly type: 'context-compacted';
  readonly checkpoint: CodingContextCheckpoint;
  readonly inputCharacters: number;
  readonly outputCharacters: number;
}

export interface CodingSessionErrorEvent {
  readonly type: 'error';
  readonly error: unknown;
}

export type CodingSessionEvent =
  | CodingSessionStateEvent
  | CodingSessionAgentEvent
  | CodingSessionTranscriptEvent
  | CodingSessionContextCompactedEvent
  | CodingSessionErrorEvent;

export interface CodingExecutionRequest {
  readonly runtime: string;
  readonly request: JsonValue;
}

export interface CreateCodingSessionOptions {
  readonly model: CodexModel;
  /** Built-in workspace tools and application-defined schema-described Codex tools. */
  readonly tools: readonly CodexAgentTool[];
  readonly configuration?: CodexAgentConfiguration;
  readonly id?: SessionId;
  /** Optional prior user/assistant messages used to resume a persisted conversation. */
  readonly transcript?: readonly CodingTranscriptEntry[];
  /** Optional provider-native checkpoint covering a leading portion of `transcript`. */
  readonly contextCheckpoint?: CodingContextCheckpoint;
  /** Opt in to provider-native compaction before the projected context reaches this size. */
  readonly contextCompaction?: {
    readonly maximumCharacters: number;
    /** Explicit host-confirmed budget for uncompressed model requests. No fallback without it.
     * Include model token/output reserves when choosing this conservative character budget. */
    readonly fallbackMaximumCharacters?: number;
  };
  readonly runtimes?: Readonly<Record<string, ExecutionRuntime<JsonValue, unknown>>>;
}

export interface CodingSession {
  readonly id: SessionId;
  readonly state: CodingSessionState;
  readonly transcript: readonly CodingTranscriptEntry[];
  readonly contextCheckpoint: CodingContextCheckpoint | undefined;
  submit(prompt: string): AsyncIterable<CodexAgentEvent>;
  followUp(prompt: string): AsyncIterable<CodexAgentEvent>;
  execute(request: CodingExecutionRequest): AsyncIterable<unknown>;
  cancel(reason?: unknown): void;
  subscribe(listener: (event: CodingSessionEvent) => void): () => void;
  dispose(): Promise<void>;
}

interface CompactableCodexModel extends CodexModel {
  compact(
    request: CodexModelRequest,
    context?: OperationContext,
  ): Promise<{ readonly items: readonly JsonObject[] }>;
}

function configuration(value: CodexAgentConfiguration | undefined): DeepReadonly<JsonObject> {
  return immutableJson({
    ...(value?.maxTurns === undefined ? {} : { maxTurns: value.maxTurns }),
    ...(value?.instructions === undefined ? {} : { instructions: value.instructions }),
  }) as DeepReadonly<JsonObject>;
}

function contextualPrompt(transcript: readonly CodingTranscriptEntry[], prompt: string): string {
  if (transcript.length === 0) return prompt;
  const history = transcript
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join('\n\n');
  return `Continue this coding conversation. Preserve decisions from the transcript.\n\n${history}\n\nUser: ${prompt}`;
}

function initialTranscript(
  value: readonly CodingTranscriptEntry[] | undefined,
): CodingTranscriptEntry[] {
  if (value === undefined) return [];
  const candidate: unknown = value;
  if (!Array.isArray(candidate) || candidate.length > 2_000) {
    throw new TypeError('Coding transcript must contain at most 2,000 entries.');
  }
  let characters = 0;
  return (candidate as readonly unknown[]).map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('role' in entry) ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      !('content' in entry) ||
      typeof entry.content !== 'string'
    ) {
      throw new TypeError('Coding transcript entries require a user or assistant role and text.');
    }
    characters += entry.content.length;
    if (characters > 4 * 1024 * 1024) {
      throw new TypeError('Coding transcript exceeds the 4 MiB text limit.');
    }
    return Object.freeze({ role: entry.role, content: entry.content });
  });
}

function contextCheckpoint(
  value: CodingContextCheckpoint | undefined,
  transcriptLength: number,
): CodingContextCheckpoint | undefined {
  if (value === undefined) return undefined;
  const candidate: unknown = value;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('items' in candidate) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length === 0 ||
    candidate.items.length > 2_000 ||
    !('coveredTranscriptEntries' in candidate) ||
    typeof candidate.coveredTranscriptEntries !== 'number' ||
    !Number.isInteger(candidate.coveredTranscriptEntries) ||
    candidate.coveredTranscriptEntries < 0 ||
    candidate.coveredTranscriptEntries > transcriptLength
  ) {
    throw new TypeError('Coding context checkpoint is invalid for this transcript.');
  }
  const items = (candidate.items as readonly unknown[]).map((item) => {
    const normalized = immutableJson(item);
    if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
      throw new TypeError('Coding context checkpoint items must be JSON objects.');
    }
    if (
      typeof (normalized as JsonObject).type !== 'string' ||
      (normalized as JsonObject).type === '' ||
      (normalized as JsonObject).type === 'compaction_trigger'
    ) {
      throw new TypeError('Coding checkpoint item requires a type.');
    }
    return normalized as JsonObject;
  });
  return Object.freeze({
    items: Object.freeze(items),
    coveredTranscriptEntries: candidate.coveredTranscriptEntries,
  });
}

function maximumContextCharacters(
  value: CreateCodingSessionOptions['contextCompaction'],
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    !Number.isInteger(value.maximumCharacters) ||
    value.maximumCharacters <= 0 ||
    value.maximumCharacters > 16 * 1024 * 1024
  ) {
    throw new TypeError(
      'Coding context compaction maximumCharacters must be an integer from 1 through 16 MiB.',
    );
  }
  return value.maximumCharacters;
}

function compactableModel(model: CodexModel): CompactableCodexModel | undefined {
  const candidate = model as CodexModel & { readonly compact?: unknown };
  return typeof candidate.compact === 'function' ? (candidate as CompactableCodexModel) : undefined;
}

function encodedCharacters(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded.length;
  } catch {
    throw new TypeError('Coding context must be JSON serializable.');
  }
}

function transcriptMessages(
  entries: readonly CodingTranscriptEntry[],
): CodexModelRequest['messages'] {
  return Object.freeze(
    entries.map((entry) =>
      entry.role === 'user'
        ? Object.freeze({ role: 'user' as const, content: entry.content })
        : Object.freeze({
            role: 'assistant' as const,
            content: entry.content,
            toolCalls: Object.freeze([]),
          }),
    ),
  );
}

let nextCodingSession = 0;

export function createCodingSession(options: CreateCodingSessionOptions): CodingSession {
  const candidate: unknown = options;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Coding session options are required.');
  }
  const listeners = new Set<(event: CodingSessionEvent) => void>();
  const entries = initialTranscript(options.transcript);
  let checkpoint = contextCheckpoint(options.contextCheckpoint, entries.length);
  let coveredTranscriptEntries = checkpoint?.coveredTranscriptEntries ?? 0;
  let contextItems = checkpoint?.items ?? Object.freeze([]);
  const compactionThreshold = maximumContextCharacters(options.contextCompaction);
  const fallbackMaximum = options.contextCompaction?.fallbackMaximumCharacters;
  if (
    fallbackMaximum !== undefined &&
    (!Number.isInteger(fallbackMaximum) || fallbackMaximum < 1 || fallbackMaximum > 4 * 1024 * 1024)
  ) {
    throw new TypeError('Invalid compaction fallback context budget.');
  }
  const compactor = compactableModel(options.model);
  if (compactionThreshold !== undefined && compactor === undefined) {
    throw new TypeError('Coding context compaction requires a model with compact().');
  }
  const runtimes = Object.freeze({ ...(options.runtimes ?? {}) });
  nextCodingSession += 1;
  const id = options.id ?? sessionId(`coding-${String(nextCodingSession)}`);
  let fallbackActive = false;
  const measuredModel = options.model as CodexModel & {
    requestCharacters?: (request: CodexModelRequest) => number;
  };
  const guardedModel: CodexModel = {
    ...(compactor === undefined ? {} : { compact: compactor.compact.bind(compactor) }),
    async *generate(request, context) {
      if (fallbackActive) {
        const size = measuredModel.requestCharacters?.(request);
        if (
          size === undefined ||
          fallbackMaximum === undefined ||
          size >= fallbackMaximum ||
          size >= 4 * 1024 * 1024 - 4096
        ) {
          throw new CodexAgentError(
            'COMPACTION_UNAVAILABLE',
            'Compaction unavailable/context limit: uncompressed generation cannot fit the verified budget.',
            { contextCompactionRequired: true },
          );
        }
      }
      yield* options.model.generate(request, context);
    },
  };
  const agent = CODEX_AGENT_FACTORY.create({
    model: guardedModel,
    tools: options.tools,
    configuration: configuration(options.configuration),
  }) as CodexAgent;
  let state: CodingSessionState = 'idle';
  let active: CancellationSource | undefined;

  const emit = (event: CodingSessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const setState = (next: CodingSessionState): void => {
    state = next;
    emit(Object.freeze({ type: 'state', state: next }));
  };
  const assertReady = (): void => {
    if (state === 'disposed') throw new Error('Coding session is disposed.');
    if (state === 'running') throw new Error('Coding session already has an active operation.');
  };

  const submit = async function* (prompt: string): AsyncIterable<CodexAgentEvent> {
    assertReady();
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new TypeError('Coding prompt must be non-empty.');
    }
    const cancellation = createCancellationSource();
    active = cancellation;
    setState('running');
    let response = '';
    fallbackActive = false;
    try {
      const pendingEntries = entries.slice(coveredTranscriptEntries);
      const inputCharacters = encodedCharacters({
        contextItems,
        messages: transcriptMessages(pendingEntries),
        prompt,
      });
      if (
        compactionThreshold !== undefined &&
        compactor !== undefined &&
        inputCharacters >= compactionThreshold &&
        (contextItems.length > 0 || pendingEntries.length > 0)
      ) {
        try {
          const result = await compactor.compact(
            {
              instructions: options.configuration?.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
              ...(contextItems.length === 0 ? {} : { contextItems }),
              messages: transcriptMessages(pendingEntries),
              tools: Object.freeze([]),
            },
            { sessionId: id, signal: cancellation.signal },
          );
          cancellation.signal.throwIfCancelled();
          const nextCheckpoint = contextCheckpoint(
            {
              items: result.items,
              coveredTranscriptEntries: entries.length,
            },
            entries.length,
          );
          if (nextCheckpoint === undefined) {
            throw new TypeError('Coding context compactor returned no checkpoint.');
          }
          checkpoint = nextCheckpoint;
          contextItems = checkpoint.items;
          coveredTranscriptEntries = checkpoint.coveredTranscriptEntries;
          emit(
            Object.freeze({
              type: 'context-compacted',
              checkpoint,
              inputCharacters,
              outputCharacters: encodedCharacters(contextItems),
            }),
          );
        } catch (error) {
          cancellation.signal.throwIfCancelled();
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          const eligible = [
            'COMPACTION_UNAVAILABLE',
            'HTTP_ERROR',
            'PROVIDER_ERROR',
            'MALFORMED_RESPONSE',
            'DEADLINE_EXCEEDED',
          ].includes(String(code));
          // The caller's budget covers context. Actual wire/transport limits are enforced by the model/relay.
          // Include instructions/tools and the real contextual prompt, not only transcript text.
          const projected = encodedCharacters({
            instructions: options.configuration?.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
            contextItems,
            messages: [
              {
                role: 'user',
                content: contextualPrompt(entries.slice(coveredTranscriptEntries), prompt),
              },
            ],
            tools: options.tools,
          });
          if (!eligible) throw error;
          if (
            (typeof error === 'object' &&
              error !== null &&
              'contextCompactionRequired' in error &&
              error.contextCompactionRequired === true) ||
            fallbackMaximum === undefined ||
            measuredModel.requestCharacters === undefined ||
            projected >= fallbackMaximum
          ) {
            throw new CodexAgentError(
              'COMPACTION_UNAVAILABLE',
              'Compaction unavailable/context limit: the original transcript and checkpoint are intact. Retry after restoring compaction or increasing a verified context budget.',
              {
                cause: error,
                contextCompactionRequired: true,
              },
            );
          }
          fallbackActive = true;
        }
      }
      const requestPrompt = contextualPrompt(entries.slice(coveredTranscriptEntries), prompt);
      const userEntry = Object.freeze({ role: 'user' as const, content: prompt });
      entries.push(userEntry);
      emit(Object.freeze({ type: 'transcript', entry: userEntry }));
      for await (const event of agent.run(
        {
          prompt: requestPrompt,
          ...(contextItems.length === 0 ? {} : { contextItems }),
        },
        { sessionId: id, signal: cancellation.signal },
      )) {
        if (event.type === 'text') response += event.text;
        if (event.type === 'context-compacted') {
          const nextCheckpoint = contextCheckpoint(
            {
              items: event.items,
              coveredTranscriptEntries: entries.length,
            },
            entries.length,
          );
          if (nextCheckpoint === undefined) {
            throw new TypeError('Coding agent returned no context checkpoint.');
          }
          checkpoint = nextCheckpoint;
          contextItems = checkpoint.items;
          coveredTranscriptEntries = checkpoint.coveredTranscriptEntries;
          emit(
            Object.freeze({
              type: 'context-compacted',
              checkpoint,
              inputCharacters: event.inputCharacters,
              outputCharacters: event.outputCharacters,
            }),
          );
        }
        emit(Object.freeze({ type: 'agent', event }));
        yield event;
      }
      const assistantEntry = Object.freeze({ role: 'assistant' as const, content: response });
      entries.push(assistantEntry);
      emit(Object.freeze({ type: 'transcript', entry: assistantEntry }));
    } catch (error) {
      emit(Object.freeze({ type: 'error', error }));
      throw error;
    } finally {
      if (active === cancellation) active = undefined;
      if (state !== 'disposed') setState('idle');
    }
  };

  const execute = async function* (request: CodingExecutionRequest): AsyncIterable<unknown> {
    assertReady();
    const runtime = runtimes[request.runtime];
    if (runtime === undefined) throw new Error(`Unknown execution runtime '${request.runtime}'.`);
    const cancellation = createCancellationSource();
    active = cancellation;
    setState('running');
    const context: OperationContext = { sessionId: id, signal: cancellation.signal };
    try {
      for await (const event of runtime.execute(request.request, context)) yield event;
    } catch (error) {
      emit(Object.freeze({ type: 'error', error }));
      throw error;
    } finally {
      if (active === cancellation) active = undefined;
      if (state !== 'disposed') setState('idle');
    }
  };

  return Object.freeze({
    id,
    get state() {
      return state;
    },
    get transcript() {
      return Object.freeze([...entries]);
    },
    get contextCheckpoint() {
      return checkpoint;
    },
    submit,
    followUp: submit,
    execute,
    cancel(reason?: unknown) {
      active?.cancel(reason);
    },
    subscribe(listener: (event: CodingSessionEvent) => void) {
      if (state === 'disposed') throw new Error('Coding session is disposed.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (state === 'disposed') return Promise.resolve();
      active?.cancel(new Error('Coding session disposed.'));
      active = undefined;
      setState('disposed');
      listeners.clear();
      return Promise.resolve();
    },
  });
}
