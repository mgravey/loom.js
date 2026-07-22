import {
  CODEX_AGENT_FACTORY,
  type CodexAgentConfiguration,
  type CodexAgentEvent,
  type CodexAgentTool,
  type CodexAgent,
  type CodexModel,
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

export interface CodingSessionErrorEvent {
  readonly type: 'error';
  readonly error: unknown;
}

export type CodingSessionEvent =
  | CodingSessionStateEvent
  | CodingSessionAgentEvent
  | CodingSessionTranscriptEvent
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
  readonly runtimes?: Readonly<Record<string, ExecutionRuntime<JsonValue, unknown>>>;
}

export interface CodingSession {
  readonly id: SessionId;
  readonly state: CodingSessionState;
  readonly transcript: readonly CodingTranscriptEntry[];
  submit(prompt: string): AsyncIterable<CodexAgentEvent>;
  followUp(prompt: string): AsyncIterable<CodexAgentEvent>;
  execute(request: CodingExecutionRequest): AsyncIterable<unknown>;
  cancel(reason?: unknown): void;
  subscribe(listener: (event: CodingSessionEvent) => void): () => void;
  dispose(): Promise<void>;
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

let nextCodingSession = 0;

export function createCodingSession(options: CreateCodingSessionOptions): CodingSession {
  const candidate: unknown = options;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Coding session options are required.');
  }
  const listeners = new Set<(event: CodingSessionEvent) => void>();
  const entries = initialTranscript(options.transcript);
  const runtimes = Object.freeze({ ...(options.runtimes ?? {}) });
  nextCodingSession += 1;
  const id = options.id ?? sessionId(`coding-${String(nextCodingSession)}`);
  const agent = CODEX_AGENT_FACTORY.create({
    model: options.model,
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
    const requestPrompt = contextualPrompt(entries, prompt);
    const userEntry = Object.freeze({ role: 'user' as const, content: prompt });
    entries.push(userEntry);
    emit(Object.freeze({ type: 'transcript', entry: userEntry }));
    const cancellation = createCancellationSource();
    active = cancellation;
    setState('running');
    let response = '';
    try {
      for await (const event of agent.run(
        { prompt: requestPrompt },
        { sessionId: id, signal: cancellation.signal },
      )) {
        if (event.type === 'text') response += event.text;
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
