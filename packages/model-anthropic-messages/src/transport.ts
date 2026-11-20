import type { CancellationSignal } from '@mgravey/loom-types';

import {
  ANTHROPIC_API_ORIGIN,
  ANTHROPIC_API_VERSION,
  type AnthropicDirectTransport,
  type AnthropicDirectTransportOptions,
  type AnthropicFetch,
  type AnthropicListModelsOptions,
  type AnthropicMessagesHttpResponse,
  type AnthropicMessagesRequest,
  type AnthropicModelInfo,
} from './contracts.js';
import {
  AnthropicMessagesModelError,
  parseRetryAfter,
  providerType,
  retryableFailure,
  safeRequestId,
} from './errors.js';
import { isRecord } from './request.js';

const MANAGED_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
]);
const ADAPTER_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'max_tokens',
  'stream',
  'thinking',
  'output_config',
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const HEADER_VALUE = /^[\t\x20-\x7e]{1,4096}$/u;
const BETA = /^[A-Za-z0-9._-]{1,128}$/u;
const VERSION = /^\d{4}-\d{2}-\d{2}$/u;
const MAXIMUM_CATALOG_CHARACTERS = 4 * 1024 * 1024;
const MAXIMUM_MODELS = 5000;

function configuration(message: string): AnthropicMessagesModelError {
  return new AnthropicMessagesModelError('INVALID_CONFIGURATION', message);
}

function baseUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? ANTHROPIC_API_ORIGIN);
  } catch {
    throw configuration('Anthropic baseUrl must be an absolute URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw configuration('Anthropic baseUrl must be HTTPS without credentials, query, or fragment.');
  return url.href.replace(/\/+$/u, '');
}

function linkSignal(signal: CancellationSignal | undefined) {
  const controller = new AbortController();
  const unsubscribe = signal?.onCancel(() => controller.abort());
  if (signal?.cancelled === true) controller.abort();
  return {
    signal: controller.signal,
    dispose() {
      unsubscribe?.();
    },
    abort() {
      controller.abort();
    },
  };
}

async function* decodeBody(
  body: ReadableStream<Uint8Array>,
  signal: CancellationSignal | undefined,
  cleanup: () => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      signal?.throwIfCancelled();
      const chunk = await reader.read();
      signal?.throwIfCancelled();
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      if (text !== '') yield text;
      if (chunk.done) break;
    }
  } catch (error) {
    signal?.throwIfCancelled();
    if (error instanceof AnthropicMessagesModelError) throw error;
    throw new AnthropicMessagesModelError(
      'TRANSPORT_FAILED',
      'Anthropic response stream was interrupted.',
      { retryable: true },
    );
  } finally {
    cleanup();
    try {
      await reader.cancel();
    } catch {
      /* Stream errors are never exposed. */
    }
    reader.releaseLock();
  }
}

async function readBounded(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.length > maximum) throw new Error('oversized');
      if (chunk.done) return text;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Bodies are never exposed. */
    }
    reader.releaseLock();
  }
}

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Direct Claude API transport for credentials the user supplies (an API key or a bearer access
 * token). Credentials are obtained per request through callbacks and never cached or exposed.
 */
export function createAnthropicDirectTransport(
  options: AnthropicDirectTransportOptions,
): AnthropicDirectTransport {
  if (!isRecord(options) || !isRecord(options.authentication))
    throw configuration('Anthropic direct transport requires authentication.');
  const authentication = options.authentication;
  const candidate: Readonly<Record<string, unknown>> = authentication;
  if (!(
    (candidate.type === 'api-key' &&
      typeof candidate.getApiKey === 'function' &&
      [undefined, 'x-api-key', 'authorization'].includes(candidate.header as string)) ||
    (candidate.type === 'bearer' && typeof candidate.getAccessToken === 'function')
  ))
    throw configuration('Anthropic direct transport authentication is invalid.');
  const root = baseUrl(options.baseUrl);
  const apiVersion = options.apiVersion ?? ANTHROPIC_API_VERSION;
  if (!VERSION.test(apiVersion)) throw configuration('Anthropic apiVersion must be YYYY-MM-DD.');
  const betas = options.betas ?? [];
  if (!Array.isArray(betas) || betas.some((beta) => typeof beta !== 'string' || !BETA.test(beta)))
    throw configuration('Anthropic betas must be header-safe identifiers.');
  const extraHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value))
      throw configuration('Anthropic headers must have valid names and values.');
    if (MANAGED_HEADERS.has(name.toLowerCase()))
      throw configuration(`Anthropic header '${name}' is managed by the transport.`);
    extraHeaders[name] = value;
  }
  const bodyFields = options.bodyFields ?? {};
  if (!isRecord(bodyFields) || Object.keys(bodyFields).some((key) => ADAPTER_FIELDS.has(key)))
    throw configuration('Anthropic bodyFields cannot replace adapter-managed fields.');
  if (
    options.dangerouslyAllowBrowser !== undefined &&
    typeof options.dangerouslyAllowBrowser !== 'boolean'
  )
    throw configuration('Anthropic dangerouslyAllowBrowser must be boolean.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function')
    throw configuration('Anthropic fetch must be a function.');
  const fetch: AnthropicFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function credentialHeaders(): Promise<Record<string, string>> {
    let value: unknown;
    try {
      value =
        authentication.type === 'api-key'
          ? await authentication.getApiKey()
          : await authentication.getAccessToken();
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string' || value.trim() === '' || !HEADER_VALUE.test(value))
      throw new AnthropicMessagesModelError(
        'AUTHENTICATION_FAILED',
        'Anthropic credentials are unavailable.',
      );
    if (authentication.type === 'api-key' && authentication.header !== 'authorization')
      return { 'x-api-key': value };
    return { Authorization: `Bearer ${value}` };
  }

  async function headers(accept: string, json: boolean): Promise<Record<string, string>> {
    return {
      ...extraHeaders,
      ...(await credentialHeaders()),
      'anthropic-version': apiVersion,
      ...(betas.length === 0 ? {} : { 'anthropic-beta': betas.join(',') }),
      ...(options.dangerouslyAllowBrowser === true
        ? { 'anthropic-dangerous-direct-browser-access': 'true' }
        : {}),
      Accept: accept,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async function request(
    url: string,
    init: RequestInit,
    signal: CancellationSignal | undefined,
    link: ReturnType<typeof linkSignal>,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: link.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      signal?.throwIfCancelled();
      throw new AnthropicMessagesModelError(
        'TRANSPORT_FAILED',
        'Anthropic is unreachable from this environment. Check the network and browser access.',
        { retryable: true },
      );
    }
  }

  function withBodyFields(body: string): string {
    if (Object.keys(bodyFields).length === 0) return body;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new AnthropicMessagesModelError('INVALID_REQUEST', 'Invalid Anthropic request body.');
    }
    if (!isRecord(value))
      throw new AnthropicMessagesModelError('INVALID_REQUEST', 'Invalid Anthropic request body.');
    return JSON.stringify({ ...value, ...bodyFields });
  }

  return Object.freeze({
    async send(messageRequest: AnthropicMessagesRequest): Promise<AnthropicMessagesHttpResponse> {
      const signal = messageRequest.signal;
      signal?.throwIfCancelled();
      if (typeof messageRequest.body !== 'string')
        throw new AnthropicMessagesModelError('INVALID_REQUEST', 'Invalid Anthropic request body.');
      const body = withBodyFields(messageRequest.body);
      const requestHeaders = await headers('text/event-stream, application/json', true);
      signal?.throwIfCancelled();
      const link = linkSignal(signal);
      let response: Response;
      try {
        response = await request(
          `${root}/v1/messages`,
          { method: 'POST', headers: requestHeaders, body },
          signal,
          link,
        );
      } catch (error) {
        link.dispose();
        throw error;
      }
      const requestId = safeRequestId(response.headers.get('request-id'));
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const contentType = response.headers.get('content-type') ?? undefined;
      const metadata = {
        ...(requestId === undefined ? {} : { requestId }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(contentType === undefined ? {} : { contentType }),
      };
      if (response.body === null) {
        link.dispose();
        return Object.freeze({ status: response.status, body: '', ...metadata });
      }
      return Object.freeze({
        status: response.status,
        body: decodeBody(response.body, signal, () => {
          link.dispose();
          link.abort();
        }),
        ...metadata,
      });
    },

    async listModels(
      listOptions: AnthropicListModelsOptions = {},
    ): Promise<readonly AnthropicModelInfo[]> {
      const limit = listOptions.limit ?? 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_MODELS)
        throw configuration('Anthropic model list limit must be between 1 and 5000.');
      const signal = listOptions.signal;
      const models: AnthropicModelInfo[] = [];
      const seen = new Set<string>();
      let after: string | undefined;
      for (let page = 0; page < 10 && models.length < limit; page += 1) {
        signal?.throwIfCancelled();
        const query = new URLSearchParams({ limit: String(Math.min(1000, limit - models.length)) });
        if (after !== undefined) query.set('after_id', after);
        const requestHeaders = await headers('application/json', false);
        const link = linkSignal(signal);
        let data: unknown;
        let response: Response | undefined;
        try {
          response = await request(
            `${root}/v1/models?${query.toString()}`,
            { method: 'GET', headers: requestHeaders },
            signal,
            link,
          );
          const text = await readBounded(response, MAXIMUM_CATALOG_CHARACTERS);
          data = JSON.parse(text);
        } catch (error) {
          signal?.throwIfCancelled();
          if (error instanceof AnthropicMessagesModelError) throw error;
          if (response === undefined || response.ok)
            throw new AnthropicMessagesModelError(
              'MALFORMED_RESPONSE',
              'Anthropic returned an invalid model list.',
            );
          data = undefined;
        } finally {
          link.dispose();
          link.abort();
        }
        if (!response.ok) {
          const type = providerType(
            isRecord(data) && isRecord(data.error) ? data.error.type : undefined,
          );
          const requestId = safeRequestId(response.headers.get('request-id'));
          throw new AnthropicMessagesModelError(
            response.status === 401 ? 'AUTHENTICATION_FAILED' : 'HTTP_ERROR',
            `Anthropic models could not be listed (HTTP ${String(response.status)}).`,
            {
              status: response.status,
              ...(type === undefined ? {} : { providerCode: type }),
              retryable: retryableFailure(response.status, type),
              ...(requestId === undefined ? {} : { requestId }),
            },
          );
        }
        if (!isRecord(data) || !Array.isArray(data.data))
          throw new AnthropicMessagesModelError(
            'MALFORMED_RESPONSE',
            'Anthropic returned an invalid model list.',
          );
        for (const item of data.data) {
          if (!isRecord(item) || !boundedString(item.id) || seen.has(item.id)) continue;
          seen.add(item.id);
          const created = boundedString(item.created_at, 64) ? item.created_at : undefined;
          const maxInputTokens = positiveInteger(item.max_input_tokens);
          const maxTokens = positiveInteger(item.max_tokens);
          models.push(
            Object.freeze({
              id: item.id,
              displayName: boundedString(item.display_name) ? item.display_name : item.id,
              ...(created === undefined ? {} : { createdAt: created }),
              ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
              ...(maxTokens === undefined ? {} : { maxTokens }),
            }),
          );
          if (models.length >= limit) break;
        }
        if (data.has_more !== true || !boundedString(data.last_id)) break;
        after = data.last_id;
      }
      return Object.freeze(models);
    },
  });
}
