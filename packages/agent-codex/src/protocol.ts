import type { Model } from '@loom/plugin-api';
import type { WorkspaceOperation } from '@loom/tool-workspace';
import type { JsonObject, JsonValue } from '@loom/types';

export interface CodexUserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface CodexAssistantToolCall {
  readonly id: string;
  readonly operation: WorkspaceOperation;
  readonly input: JsonObject;
  /** Opaque provider continuation metadata for a nested hosted-program call. */
  readonly caller?: JsonObject;
}

export interface CodexAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly CodexAssistantToolCall[];
  /** Opaque output items that a stateless model adapter must replay verbatim. */
  readonly continuationItems?: readonly JsonObject[];
}

export interface CodexToolMessage {
  readonly role: 'tool';
  readonly callId: string;
  readonly operation: WorkspaceOperation;
  readonly result: JsonValue;
  /** Copied unchanged from the corresponding nested tool call. */
  readonly caller?: JsonObject;
}

export type CodexModelMessage = CodexUserMessage | CodexAssistantMessage | CodexToolMessage;

export interface CodexModelToolDefinition {
  readonly operation: WorkspaceOperation;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly allowedCallers?: readonly ('direct' | 'programmatic')[];
}

export interface CodexModelRequest {
  readonly instructions: string;
  readonly messages: readonly CodexModelMessage[];
  readonly tools: readonly CodexModelToolDefinition[];
}

export interface CodexModelTextEvent {
  readonly type: 'text';
  readonly text: string;
}

export interface CodexModelToolCallEvent {
  readonly type: 'tool-call';
  readonly call: {
    readonly id: string;
    readonly operation: string;
    readonly input: JsonObject;
    readonly caller?: JsonObject;
  };
}

export interface CodexModelContinuationEvent {
  readonly type: 'continuation';
  readonly item: JsonObject;
}

export interface CodexModelCompletedEvent {
  readonly type: 'completed';
  /** False when the stateless model must be continued before a final assistant message exists. */
  readonly final?: boolean;
}

export type CodexModelEvent =
  | CodexModelTextEvent
  | CodexModelToolCallEvent
  | CodexModelContinuationEvent
  | CodexModelCompletedEvent;

export type CodexModel = Model<CodexModelRequest, CodexModelEvent>;
export type CodexAgentModel = CodexModel;

export interface CodexAgentTextEvent {
  readonly type: 'text';
  readonly text: string;
}

export interface CodexAgentToolStartEvent {
  readonly type: 'tool-start';
  readonly callId: string;
  readonly operation: WorkspaceOperation;
  readonly input: JsonObject;
  readonly caller?: JsonObject;
}

export interface CodexAgentToolFinishEvent {
  readonly type: 'tool-finish';
  readonly callId: string;
  readonly operation: WorkspaceOperation;
  readonly result: JsonValue;
  readonly caller?: JsonObject;
}

export interface CodexAgentCompletedEvent {
  readonly type: 'completed';
  readonly turns: number;
}

export type CodexAgentEvent =
  | CodexAgentTextEvent
  | CodexAgentToolStartEvent
  | CodexAgentToolFinishEvent
  | CodexAgentCompletedEvent;
