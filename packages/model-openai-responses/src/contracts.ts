import type { AuthProvider } from '@loom/plugin-api';
import type { CancellationSignal } from '@loom/types';

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

/** Preferred secure-host boundary: the Loom caller never receives an API key. */
export interface OpenAIResponsesTransport {
  send(request: OpenAIResponsesRequest): Promise<OpenAIResponsesHttpResponse>;
}

export type OpenAIResponsesFetch = (
  request: OpenAIResponsesHttpRequest,
) => Promise<OpenAIResponsesHttpResponse>;

export type OpenAIApiKeySupplier = () => Promise<string>;
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
