import type { ExtensionAuthProvider, ExternalMessageRuntime } from '@mgravey/loom-auth-extension';
import type {
  CodexResponsesFetch,
  CodexResponsesTransport,
} from '@mgravey/loom-model-codex-experimental';
import type { LoomPlugin } from '@mgravey/loom-plugin-api';

export interface ExternalPortMessageEvent {
  addListener(listener: (message: unknown) => void): void;
}

export interface ExternalPortDisconnectEvent {
  addListener(listener: () => void): void;
}

/** Minimal external Chrome port surface used by a normal website. */
export interface CodexCompanionPort {
  readonly onMessage: ExternalPortMessageEvent;
  readonly onDisconnect: ExternalPortDisconnectEvent;
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface ExternalPortRuntime {
  connect(extensionId: string, options: { readonly name: string }): CodexCompanionPort;
}

export type CodexCompanionRuntime = ExternalMessageRuntime & ExternalPortRuntime;

export type CodexCompanionValueSource = string | (() => string);
export type CodexCompanionRuntimeSource = CodexCompanionRuntime | (() => CodexCompanionRuntime);

export type CodexCompanionDiagnosticStage =
  'origin-access' | 'connection' | 'request' | 'response' | 'stream' | 'cleanup';

export interface CodexCompanionDiagnosticEvent {
  readonly event: string;
  readonly stage: CodexCompanionDiagnosticStage;
  readonly requestId?: string;
  readonly code?: string;
  readonly status?: number;
  readonly characters?: number;
  readonly providerMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export type CodexCompanionDiagnosticSink = (event: CodexCompanionDiagnosticEvent) => void;

export interface CreateCodexExtensionTransportOptions {
  /** Defaults to the published Loom.js Companion Store ID. */
  readonly extensionId?: CodexCompanionValueSource;
  readonly runtime: CodexCompanionRuntimeSource;
  readonly sessionId: CodexCompanionValueSource;
  /** Defaults to the current session ID. */
  readonly threadId?: CodexCompanionValueSource;
  readonly requestIdFactory?: () => string;
  readonly diagnosticSink?: CodexCompanionDiagnosticSink;
}

export interface CodexOriginAccessStatus {
  readonly approved: boolean;
}

export interface RequestCodexOriginAccessOptions {
  readonly extensionId?: CodexCompanionValueSource;
  readonly runtime: CodexCompanionRuntimeSource;
  readonly requestIdFactory?: () => string;
  readonly diagnosticSink?: CodexCompanionDiagnosticSink;
}

export interface CreateCodexCompanionOptions extends CreateCodexExtensionTransportOptions {}

export interface CodexCompanionConfiguration {
  readonly extensionId: CodexCompanionValueSource;
  readonly providerId: string;
}

export interface CodexCompanion {
  readonly configuration: CodexCompanionConfiguration;
  readonly auth: ExtensionAuthProvider;
  readonly authPlugin: LoomPlugin;
  readonly transport: CodexResponsesTransport;
  readonly fetch: CodexResponsesFetch;
  requestOriginAccess(): Promise<CodexOriginAccessStatus>;
  ensureOriginAccess(): Promise<void>;
}
