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
}

export interface CodexAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly CodexAssistantToolCall[];
}

export interface CodexToolMessage {
  readonly role: 'tool';
  readonly callId: string;
  readonly operation: WorkspaceOperation;
  readonly result: JsonValue;
}

export type CodexModelMessage = CodexUserMessage | CodexAssistantMessage | CodexToolMessage;

export interface CodexModelToolDefinition {
  readonly operation: WorkspaceOperation;
  readonly description: string;
  readonly inputSchema: JsonObject;
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
  };
}

export interface CodexModelCompletedEvent {
  readonly type: 'completed';
}

export type CodexModelEvent =
  CodexModelTextEvent | CodexModelToolCallEvent | CodexModelCompletedEvent;

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
}

export interface CodexAgentToolFinishEvent {
  readonly type: 'tool-finish';
  readonly callId: string;
  readonly operation: WorkspaceOperation;
  readonly result: JsonValue;
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
