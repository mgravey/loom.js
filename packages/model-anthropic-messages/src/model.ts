import type { CodexModel, CodexModelEvent, CodexModelRequest } from '@mgravey/loom-agent-codex';
import type { OperationContext } from '@mgravey/loom-plugin-api';

import type {
  AnthropicMessagesBody,
  AnthropicMessagesHttpResponse,
  AnthropicMessagesModelOptions,
} from './contracts.js';
import {
  AnthropicMessagesModelError,
  providerType,
  retryableFailure,
  safeRequestId,
  safeRetryAfter,
} from './errors.js';
import { createAnthropicMessagesRequestBody, isRecord, toolAliases } from './request.js';
import { decodeAnthropicStream } from './stream.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAXIMUM_ERROR_CHARACTERS = 16 * 1024;
const CORS_DENIED = 'CORS requests are not allowed for this Organization';

function configuration(message: string): AnthropicMessagesModelError {
  return new AnthropicMessagesModelError('INVALID_CONFIGURATION', message);
}

function validateOptions(options: AnthropicMessagesModelOptions): AnthropicMessagesModelOptions {
  if (!isRecord(options)) throw configuration('Anthropic Messages model options are required.');
  if (typeof options.model !== 'string' || options.model.trim() === '')
    throw configuration('Anthropic Messages model must be a non-empty string.');
  if (!isRecord(options.transport) || typeof options.transport.send !== 'function')
    throw configuration('Anthropic Messages model requires an injected transport.');
  if (
    options.maxTokens !== undefined &&
    (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 1_000_000)
  )
    throw configuration('Anthropic Messages maxTokens must be a positive integer.');
  if (options.effort !== undefined && !EFFORTS.includes(options.effort))
    throw configuration('Anthropic Messages effort is invalid.');
  const thinking: unknown = options.thinking;
  if (
    thinking !== undefined &&
    !(
      isRecord(thinking) &&
      ((thinking.type === 'disabled' && Object.keys(thinking).length === 1) ||
        (thinking.type === 'adaptive' &&
          Object.keys(thinking).every((key) => key === 'type' || key === 'display') &&
          (thinking.display === undefined ||
            thinking.display === 'summarized' ||
            thinking.display === 'omitted')))
    )
  )
    throw configuration('Anthropic Messages thinking must be adaptive or disabled.');
  if (options.eagerInputStreaming !== undefined && typeof options.eagerInputStreaming !== 'boolean')
    throw configuration('Anthropic Messages eagerInputStreaming must be boolean.');
  if (options.onUsage !== undefined && typeof options.onUsage !== 'function')
    throw configuration('Anthropic Messages onUsage must be a function.');
  return options;
}

async function sendRequest(
  options: AnthropicMessagesModelOptions,
  body: string,
  context?: OperationContext,
): Promise<AnthropicMessagesHttpResponse> {
  try {
    const response: unknown = await options.transport.send(
      Object.freeze({ body, ...(context?.signal === undefined ? {} : { signal: context.signal }) }),
    );
    context?.signal?.throwIfCancelled();
    if (
      !isRecord(response) ||
      typeof response.status !== 'number' ||
      !Number.isInteger(response.status) ||
      (typeof response.body !== 'string' &&
        (!isRecord(response.body) ||
          typeof (response.body as { readonly [Symbol.asyncIterator]?: unknown })[
            Symbol.asyncIterator
          ] !== 'function')) ||
      (response.contentType !== undefined && typeof response.contentType !== 'string')
    )
      throw new Error('invalid transport response');
    return response as unknown as AnthropicMessagesHttpResponse;
  } catch (error) {
    if (error instanceof AnthropicMessagesModelError) throw error;
    context?.signal?.throwIfCancelled();
    throw new AnthropicMessagesModelError(
      'TRANSPORT_FAILED',
      'Anthropic Messages transport failed.',
    );
  }
}

async function boundedText(body: AnthropicMessagesBody, context?: OperationContext) {
  if (typeof body === 'string') return body.slice(0, MAXIMUM_ERROR_CHARACTERS + 1);
  let text = '';
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      context?.signal?.throwIfCancelled();
      const next = await iterator.next();
      if (next.done === true) break;
      if (typeof next.value !== 'string') break;
      text += next.value;
      if (text.length > MAXIMUM_ERROR_CHARACTERS) break;
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      /* Error bodies are never exposed. */
    }
  }
  return text;
}

/** Reads at most 16 KiB of an error body to select an allowlisted error type; never exposes it. */
async function httpFailure(
  response: AnthropicMessagesHttpResponse,
  context?: OperationContext,
): Promise<AnthropicMessagesModelError> {
  let type: ReturnType<typeof providerType>;
  let browserAccessDenied = false;
  try {
    const text = await boundedText(response.body, context);
    if (text.length <= MAXIMUM_ERROR_CHARACTERS) {
      const value: unknown = JSON.parse(text);
      const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
      type = providerType(error?.type);
      browserAccessDenied =
        response.status === 401 &&
        typeof error?.message === 'string' &&
        error.message.startsWith(CORS_DENIED);
    }
  } catch (error) {
    context?.signal?.throwIfCancelled();
    void error;
  }
  const requestId = safeRequestId(response.requestId);
  const retryAfterMs = safeRetryAfter(response.retryAfterMs);
  const status = response.status;
  const message = browserAccessDenied
    ? 'This Anthropic organization does not allow direct browser requests.'
    : type === 'authentication_error'
      ? 'Anthropic rejected the credential.'
      : type === 'billing_error' || status === 402
        ? 'Anthropic rejected the request for billing reasons.'
        : type === 'permission_error'
          ? 'The credential does not have permission for this request.'
          : type === 'rate_limit_error'
            ? 'Anthropic rate limit reached. Retry later.'
            : type === 'overloaded_error'
              ? 'Anthropic is temporarily overloaded. Retry later.'
              : type === 'request_too_large'
                ? 'The request is too large for Anthropic.'
                : 'Anthropic Messages request was rejected.';
  return new AnthropicMessagesModelError(
    status === 401 ? 'AUTHENTICATION_FAILED' : 'HTTP_ERROR',
    `${message} (HTTP ${String(status)}).`,
    {
      status,
      ...(type === undefined ? {} : { providerCode: type }),
      retryable: !browserAccessDenied && retryableFailure(status, type),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
      browserAccessDenied,
      ...(type === 'request_too_large' ? { contextCompactionRequired: true } : {}),
    },
  );
}

/** Creates a credential-free Loom model that streams the Anthropic Messages API. */
export function createAnthropicMessagesModel(options: AnthropicMessagesModelOptions): CodexModel {
  const validated = validateOptions(options);
  return Object.freeze({
    async *generate(
      request: CodexModelRequest,
      context?: OperationContext,
    ): AsyncIterable<CodexModelEvent> {
      context?.signal?.throwIfCancelled();
      const body = JSON.stringify(
        createAnthropicMessagesRequestBody(request, validated.model, {
          ...(validated.maxTokens === undefined ? {} : { maxTokens: validated.maxTokens }),
          ...(validated.thinking === undefined ? {} : { thinking: validated.thinking }),
          ...(validated.effort === undefined ? {} : { effort: validated.effort }),
          ...(validated.eagerInputStreaming === undefined
            ? {}
            : { eagerInputStreaming: validated.eagerInputStreaming }),
        }),
      );
      const aliases = toolAliases(request);
      const response = await sendRequest(validated, body, context);
      if (response.status < 200 || response.status >= 300)
        throw await httpFailure(response, context);
      if (
        response.contentType !== undefined &&
        !response.contentType.toLowerCase().includes('text/event-stream')
      )
        throw new AnthropicMessagesModelError(
          'MALFORMED_RESPONSE',
          'Anthropic Messages did not return an event stream.',
          { status: response.status },
        );
      try {
        yield* decodeAnthropicStream(response.body, aliases, context, validated.onUsage);
      } catch (error) {
        context?.signal?.throwIfCancelled();
        if (error instanceof AnthropicMessagesModelError) throw error;
        throw new AnthropicMessagesModelError(
          'TRANSPORT_FAILED',
          'Anthropic Messages stream was interrupted. The generation was not retried.',
          { retryable: true },
        );
      }
    },
  });
}
