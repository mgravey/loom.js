import type { AuthProvider } from '@mgravey/loom-plugin-api';
import type { CancellationSignal } from '@mgravey/loom-types';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses' as const;

export interface OpenAIResponsesRequest {
  readonly body: string;
  readonly signal?: CancellationSignal;
}

export interface OpenAIResponsesHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: CancellationSignal;
}

export interface OpenAIResponsesHttpResponse {
  readonly status: number;
  /** Complete UTF-8 JSON response body. */
  readonly body: string;
}

/** A complete JSON body or decoded UTF-8 chunks from a Responses SSE stream. */
export type OpenAICompatibleResponsesBody = string | AsyncIterable<string>;

export interface OpenAICompatibleResponsesHttpResponse {
  readonly status: number;
  readonly body: OpenAICompatibleResponsesBody;
  /** Used to distinguish a JSON fallback from an SSE response when body is a string. */
  readonly contentType?: string;
}

export interface OpenAICompatibleResponsesHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: CancellationSignal;
}

export type OpenAICompatibleResponsesFetch = (
  request: OpenAICompatibleResponsesHttpRequest,
) => Promise<OpenAICompatibleResponsesHttpResponse>;

/** Preferred secure-host boundary: the Loom caller never receives an API key. */
export interface OpenAIResponsesTransport {
  send(request: OpenAIResponsesRequest): Promise<OpenAIResponsesHttpResponse>;
}

export type OpenAIResponsesFetch = (
  request: OpenAIResponsesHttpRequest,
) => Promise<OpenAIResponsesHttpResponse>;

export type OpenAIApiKeySupplier = () => Promise<string>;
export type OpenAIReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type OpenAITextVerbosity = 'low' | 'medium' | 'high';

interface OpenAIResponsesCommonOptions {
  readonly model: string;
  /** Enabled by default; callers should verify that the selected model supports it. */
  readonly programmaticToolCalling?: boolean;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  readonly textVerbosity?: OpenAITextVerbosity;
}

export interface OpenAIResponsesTransportOptions extends OpenAIResponsesCommonOptions {
  readonly transport: OpenAIResponsesTransport;
}

/** Direct mode is for trusted hosts only. Never place a Platform API key in a browser page. */
export interface OpenAIResponsesDirectOptions extends OpenAIResponsesCommonOptions {
  readonly authentication: AuthProvider | OpenAIApiKeySupplier;
  readonly fetch: OpenAIResponsesFetch;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type CreateOpenAIResponsesModelOptions =
  OpenAIResponsesTransportOptions | OpenAIResponsesDirectOptions;

/**
 * Portable OpenAI-compatible Responses mode. The endpoint is explicit so omitting authentication
 * can never accidentally target the default OpenAI Platform URL.
 */
interface OpenAICompatibleResponsesCommonOptions {
  /** Omitted by default so the server chooses its own reasoning behavior. */
  readonly reasoningEffort?: OpenAIReasoningEffort;
  readonly model: string;
  /** Defaults to true. A JSON response is still accepted when a server ignores streaming. */
  readonly stream?: boolean;
}

/** A credential-free streaming Responses boundary owned by a trusted host. */
export interface OpenAICompatibleResponsesTransport {
  send(request: OpenAIResponsesRequest): Promise<OpenAICompatibleResponsesHttpResponse>;
}
export interface OpenAICompatibleResponsesBrokeredOptions extends OpenAICompatibleResponsesCommonOptions {
  readonly transport: OpenAICompatibleResponsesTransport;
}
export interface OpenAICompatibleResponsesDirectOptions extends OpenAICompatibleResponsesCommonOptions {
  readonly endpoint: string;
  readonly fetch: OpenAICompatibleResponsesFetch;
  readonly authentication?: AuthProvider | OpenAIApiKeySupplier;
  readonly headers?: Readonly<Record<string, string>>;
}
export type OpenAICompatibleResponsesModelOptions =
  OpenAICompatibleResponsesBrokeredOptions | OpenAICompatibleResponsesDirectOptions;
