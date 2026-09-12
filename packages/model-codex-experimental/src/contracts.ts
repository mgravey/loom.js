import type { CodexModel, CodexModelRequest } from '@mgravey/loom-agent-codex';
import type { AuthProvider, OperationContext } from '@mgravey/loom-plugin-api';
import type { CancellationSignal, JsonObject } from '@mgravey/loom-types';

export type CodexReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type CodexResponsesWireProtocol = 'classic' | 'responses-lite';
export type CodexResponsesOperation = 'generate' | 'compact';

/** A credential-free request for a trusted transport such as an extension broker. */
export interface CodexResponsesRequest {
  readonly body: string;
  /** Defaults to generate for compatibility with existing injected transports. */
  readonly operation?: CodexResponsesOperation;
  readonly wireProtocol: CodexResponsesWireProtocol;
  readonly signal?: CancellationSignal;
}

/** An HTTP request used only by the explicit direct-fetch composition mode. */
export interface CodexResponsesHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly operation?: CodexResponsesOperation;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: CancellationSignal;
}

/** Response chunks are decoded text; decoding remains the responsibility of the host transport. */
export interface CodexResponsesHttpResponse {
  readonly status: number;
  readonly body: AsyncIterable<string>;
  /** Sanitized allowlisted metadata; transports must never attach raw bodies or headers. */
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export interface CodexResponsesSseMessage {
  readonly event?: string;
  readonly data: string;
}

export interface CodexResponsesTransport {
  /** The transport owns endpoint selection, credentials, and provider-specific HTTP headers. */
  send(request: CodexResponsesRequest): Promise<CodexResponsesHttpResponse>;
}

/** Function-shaped transport for composition roots that prefer an injected fetch adapter. */
export type CodexResponsesFetch = (
  request: CodexResponsesHttpRequest,
) => Promise<CodexResponsesHttpResponse>;

export type AccessTokenSupplier = () => Promise<string>;
export type AccountIdSupplier = () => Promise<string | undefined>;

export interface CodexContextCompactionResult {
  /** Opaque, validated provider items. Persist and replay these without inspecting their content. */
  readonly items: readonly JsonObject[];
}

export interface CodexExperimentalModel extends CodexModel {
  compact(
    request: CodexModelRequest,
    context?: OperationContext,
  ): Promise<CodexContextCompactionResult>;
}

export interface CodexExperimentalModelOptions {
  readonly model: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  /** Defaults to classic. Responses Lite moves tools and instructions into input items. */
  readonly wireProtocol?: CodexResponsesWireProtocol;
  /** Preferred brokered mode: no access token is made available to the model or calling page. */
  readonly transport: CodexResponsesTransport;
}

export interface CodexExperimentalDirectFetchOptions {
  readonly model: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly wireProtocol?: CodexResponsesWireProtocol;
  /** Experimental endpoint audited by the host; intentionally no provider URL is baked in. */
  readonly endpoint: string;
  /** Defaults to `${endpoint}/compact`. */
  readonly compactEndpoint?: string;
  readonly authentication: AuthProvider | AccessTokenSupplier;
  readonly fetch: CodexResponsesFetch;
  readonly accountId?: string | AccountIdSupplier;
  readonly originator?: string;
  /** Additional non-authentication headers required by an audited host integration. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type CreateCodexExperimentalModelOptions =
  CodexExperimentalModelOptions | CodexExperimentalDirectFetchOptions;
