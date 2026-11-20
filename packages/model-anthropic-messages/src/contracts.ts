import type { CancellationSignal, JsonObject } from '@mgravey/loom-types';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com' as const;
export const ANTHROPIC_MESSAGES_ENDPOINT = `${ANTHROPIC_API_ORIGIN}/v1/messages` as const;
export const ANTHROPIC_MODELS_ENDPOINT = `${ANTHROPIC_API_ORIGIN}/v1/models` as const;
/** The `anthropic-version` sent by the direct transport unless overridden (checked 2026-11-20). */
export const ANTHROPIC_API_VERSION = '2026-10-21' as const;

/** A prepared Messages API request body. The transport owns endpoint and credentials. */
export interface AnthropicMessagesRequest {
  readonly body: string;
  readonly signal?: CancellationSignal;
}

/** A complete UTF-8 body or decoded UTF-8 chunks from a Messages SSE stream. */
export type AnthropicMessagesBody = string | AsyncIterable<string>;

export interface AnthropicMessagesHttpResponse {
  readonly status: number;
  readonly body: AnthropicMessagesBody;
  readonly contentType?: string;
  /** Format-checked `request-id` response header, when available. */
  readonly requestId?: string;
  /** Validated `retry-after` delay in milliseconds, when available. */
  readonly retryAfterMs?: number;
}

/** Credential-free boundary owned by a trusted host or by `createAnthropicDirectTransport`. */
export interface AnthropicMessagesTransport {
  send(request: AnthropicMessagesRequest): Promise<AnthropicMessagesHttpResponse>;
}

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Thinking configuration forwarded unchanged. Thinking blocks are preserved verbatim in the
 * assistant continuation so tool-use turns replay them as the API requires.
 */
export type AnthropicThinking =
  | { readonly type: 'adaptive'; readonly display?: 'summarized' | 'omitted' }
  | { readonly type: 'disabled' };

export interface AnthropicUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

export interface AnthropicMessagesModelOptions {
  /** A model ID available to the caller, for example from `listModels()`. */
  readonly model: string;
  readonly transport: AnthropicMessagesTransport;
  /** Maximum output tokens per model turn. Defaults to 32000. */
  readonly maxTokens?: number;
  /** Omitted by default so the model's own default applies. */
  readonly thinking?: AnthropicThinking;
  /** Sent as `output_config.effort`. Omitted by default. */
  readonly effort?: AnthropicEffort;
  /** Sets `eager_input_streaming` on tools. Inputs are still parsed and validated as objects. */
  readonly eagerInputStreaming?: boolean;
  /** Receives cumulative token usage once per completed turn. Observer errors are ignored. */
  readonly onUsage?: (usage: AnthropicUsage) => void;
}

/** Information returned by `GET /v1/models`. Fields are omitted when absent or invalid. */
export interface AnthropicModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
}

export interface AnthropicListModelsOptions {
  readonly signal?: CancellationSignal;
  /** Maximum number of models to return. Defaults to 1000. */
  readonly limit?: number;
}

export interface AnthropicApiKeyAuthentication {
  readonly type: 'api-key';
  /** Called before every request; the key is never cached or exposed by the transport. */
  getApiKey(): string | Promise<string>;
  /** Defaults to `x-api-key`. `authorization` sends `Authorization: Bearer <key>`. */
  readonly header?: 'x-api-key' | 'authorization';
}

/** Bearer access token, for example from a Claude Platform OAuth (linked billing) connection. */
export interface AnthropicBearerAuthentication {
  readonly type: 'bearer';
  /** Called before every request; the host owns token refresh. No `x-api-key` is sent. */
  getAccessToken(): string | Promise<string>;
}

export type AnthropicDirectAuthentication =
  AnthropicApiKeyAuthentication | AnthropicBearerAuthentication;

export type AnthropicFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AnthropicDirectTransportOptions {
  readonly authentication: AnthropicDirectAuthentication;
  /** Defaults to `https://api.anthropic.com`. Must be HTTPS (or HTTP on a loopback host). */
  readonly baseUrl?: string;
  /** Defaults to `ANTHROPIC_API_VERSION`. */
  readonly apiVersion?: string;
  /**
   * Sends `anthropic-dangerous-direct-browser-access: true`, which the API requires for
   * cross-origin browser requests. Only enable it when the user supplies their own credential.
   */
  readonly dangerouslyAllowBrowser?: boolean;
  /** Joined into `anthropic-beta`. */
  readonly betas?: readonly string[];
  /** Extra headers such as `anthropic-user-profile-id`. Managed headers cannot be overridden. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Extra top-level Messages body fields such as `billing_policy`. Cannot replace adapter fields. */
  readonly bodyFields?: JsonObject;
  /** Defaults to the global `fetch`. */
  readonly fetch?: AnthropicFetch;
}

export interface AnthropicDirectTransport extends AnthropicMessagesTransport {
  listModels(options?: AnthropicListModelsOptions): Promise<readonly AnthropicModelInfo[]>;
}
