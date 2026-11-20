import { GoogleSubscriptionError } from './google-subscription.js';
import {
  createOriginAuthorizer,
  ExtensionBrokerError,
  type ExtensionTokenService,
  type OriginAuthorizer,
} from '@mgravey/loom-extension';
import type { CodexAccountRoutingStore } from './account-routing.js';
import type { CodexExternalPort, CodexModelFetch } from './chrome-contracts.js';
import { DEVELOPMENT_ALLOWED_ORIGINS } from './composition.js';

import { nativeRequest, nativeResponse, serverHeaders } from './server-provider.js';
import type { ServerProvider, ResponsesConnectionStore } from './responses-connections.js';

export const CUSTOM_RESPONSES_PORT_NAME = 'loom/responses/v1';
export const CUSTOM_RESPONSES_PROTOCOL = 'loom/responses';

export const CODEX_MODEL_PORT_NAME = 'loom/codex-model-experimental/v1' as const;
export const CODEX_MODEL_TRANSPORT_PROTOCOL = 'loom/codex-model-experimental' as const;
export const CODEX_MODEL_TRANSPORT_VERSION = 1 as const;
export const CODEX_MODEL_END_ACK_TIMEOUT_MS = 1_000 as const;
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses' as const;
export const CODEX_RESPONSES_COMPACT_ENDPOINT = CODEX_RESPONSES_ENDPOINT;

const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_PROVIDER_ERROR_BODY_LENGTH = 16 * 1024;
const MAXIMUM_PROVIDER_MESSAGE_LENGTH = 512;
const MAXIMUM_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const GENERIC_PROVIDER_MESSAGE = 'The provider rejected the request.';
// Unknown custom-server error codes may themselves contain a reflected credential.
const CUSTOM_PROVIDER_CODES = new Set([
  'invalid_api_key',
  'authentication_error',
  'unauthorized',
  'permission_denied',
  'rate_limit_exceeded',
  'too_many_requests',
  'insufficient_quota',
  'model_not_found',
  'context_length_exceeded',
  'context_window_exceeded',
  'invalid_request_error',
  'server_error',
  'overloaded',
  'service_unavailable',
  'unsupported_operation',
  'rate_limit_error',
  'overloaded_error',
  'api_error',
  'not_found_error',
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'NOT_FOUND',
  'INTERNAL',
  'UNAVAILABLE',
]);
const NON_RETRYABLE_PROVIDER_CODE =
  /(account|auth|billing|credit|forbidden|insufficient_quota|invalid|payment|permission|policy|quota_exceeded|restricted|unauthorized)/u;

interface CodexPortRequest {
  readonly protocol: typeof CODEX_MODEL_TRANSPORT_PROTOCOL | typeof CUSTOM_RESPONSES_PROTOCOL;
  readonly connectionId?: string;
  readonly version: typeof CODEX_MODEL_TRANSPORT_VERSION;
  readonly type: 'generate' | 'compact';
  readonly requestId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly model: string;
  readonly body: string;
  readonly wireProtocol: 'classic' | 'responses-lite';
}

export interface CreateCodexModelPortListenerOptions {
  readonly customResponses?: {
    readonly store: ResponsesConnectionStore;
    readonly authorizer: OriginAuthorizer;
  };
  readonly providerId: string;
  readonly tokenService: ExtensionTokenService;
  readonly accountRoutingStore: CodexAccountRoutingStore;
  readonly fetchRequest: CodexModelFetch;
  readonly authorizer?: OriginAuthorizer;
  readonly diagnosticSink?: CodexModelDiagnosticSink;
}

export type CodexModelDiagnosticStage =
  'port' | 'authorization' | 'validation' | 'routing' | 'authentication' | 'provider' | 'stream';

export type CodexModelTransportFailureCode =
  | 'DEADLINE_EXCEEDED'
  | 'CONNECTION_UNAVAILABLE'
  | 'CANCELLED'
  | 'UNAUTHORIZED_ORIGIN'
  | 'INVALID_REQUEST'
  | 'ACCOUNT_ROUTING_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'PROVIDER_FETCH_FAILED'
  | 'PROVIDER_STREAM_FAILED';

export interface CodexModelDiagnosticEvent {
  readonly event: string;
  readonly stage: CodexModelDiagnosticStage;
  readonly requestId?: string;
  readonly operation?: 'generate' | 'compact';
  readonly code?: CodexModelTransportFailureCode;
  readonly brokerCode?: string;
  readonly status?: number;
  readonly characters?: number;
  readonly chunks?: number;
  readonly method?: 'POST';
  readonly targetHost?: string;
  readonly targetPath?: string;
  readonly model?: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export type CodexModelDiagnosticSink = (event: CodexModelDiagnosticEvent) => void;

function report(
  sink: CodexModelDiagnosticSink | undefined,
  event: CodexModelDiagnosticEvent,
): void {
  try {
    sink?.(Object.freeze(event));
  } catch {
    // Diagnostics must never alter authentication, transport, or cleanup behavior.
  }
}

function failureCode(
  stage: CodexModelDiagnosticStage,
  aborted: boolean,
): CodexModelTransportFailureCode {
  if (aborted) return 'CANCELLED';
  if (stage === 'authorization') return 'UNAUTHORIZED_ORIGIN';
  if (stage === 'validation' || stage === 'port') return 'INVALID_REQUEST';
  if (stage === 'routing') return 'ACCOUNT_ROUTING_UNAVAILABLE';
  if (stage === 'authentication') return 'AUTHENTICATION_FAILED';
  if (stage === 'stream') return 'PROVIDER_STREAM_FAILED';
  return 'PROVIDER_FETCH_FAILED';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximumLength;
}

function headerIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/u.test(value);
}

function providerIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._:[\]-]{1,256}$/u.test(value)
    ? value
    : undefined;
}

function withoutControlCharacters(value: string): string {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character;
  }
  return sanitized;
}

function sanitizedProviderMessage(value: unknown): string {
  if (typeof value !== 'string') return GENERIC_PROVIDER_MESSAGE;
  const sanitized = withoutControlCharacters(value.slice(0, MAXIMUM_PROVIDER_MESSAGE_LENGTH * 4))
    .replaceAll(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replaceAll(/\bsk-[a-z0-9_-]{8,}\b/giu, '[REDACTED]')
    .replaceAll(
      /("?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)"?\s*:\s*")[^"]*"/giu,
      '$1[REDACTED]"',
    )
    .replaceAll(
      /('?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)'?\s*:\s*')[^']*'/giu,
      "$1[REDACTED]'",
    )
    .replaceAll(/\b(cookie|set-cookie|authorization)\b\s*[:=]\s*.+$/giu, '$1: [REDACTED]')
    .replaceAll(
      /\b(api[-_ ]?key|authorization|cookie|set-cookie|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)\b(\s*[:=]\s*|"\s*:\s*")[^,\s;"'}]+/giu,
      '$1$2[REDACTED]',
    )
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return (sanitized || GENERIC_PROVIDER_MESSAGE).slice(0, MAXIMUM_PROVIDER_MESSAGE_LENGTH);
}

function retryableProviderFailure(status: number, providerCode?: string): boolean {
  const normalizedCode = providerCode?.toLowerCase();
  if (normalizedCode !== undefined && NON_RETRYABLE_PROVIDER_CODE.test(normalizedCode))
    return false;
  return (
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    ['rate_limit_exceeded', 'server_error', 'service_unavailable'].includes(normalizedCode ?? '')
  );
}

interface ProviderErrorMetadata {
  readonly providerCode?: string;
  readonly providerMessage: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

function retryAfterMilliseconds(
  headers: { get(name: string): string | null } | undefined,
  now = Date.now(),
): number | undefined {
  let value: string | undefined;
  try {
    value = headers?.get('Retry-After')?.trim();
  } catch {
    return undefined;
  }
  if (value === undefined || value === '') return undefined;
  let milliseconds: number;
  if (/^\d+$/u.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt)) return undefined;
    milliseconds = Math.max(0, retryAt - now);
  }
  if (!Number.isFinite(milliseconds)) return undefined;
  return Math.min(Math.round(milliseconds), MAXIMUM_RETRY_AFTER_MS);
}

async function readProviderErrorMetadata(
  body: ReadableStream<Uint8Array> | null,
  status: number,
  retryAfterMs: number | undefined,
): Promise<ProviderErrorMetadata> {
  const fallback = Object.freeze({
    providerMessage: GENERIC_PROVIDER_MESSAGE,
    retryable: retryableProviderFailure(status),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (body === null) return fallback;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAXIMUM_PROVIDER_ERROR_BODY_LENGTH) {
        await reader.cancel();
        return fallback;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return fallback;
  } finally {
    reader.releaseLock();
  }

  try {
    const envelope: unknown = JSON.parse(text);
    const error =
      isRecord(envelope) && isRecord(envelope.error)
        ? envelope.error
        : isRecord(envelope)
          ? envelope
          : undefined;
    if (error === undefined) return fallback;
    const providerCode =
      providerIdentifier(error.code) ??
      providerIdentifier(error.type) ??
      providerIdentifier(error.status);
    return Object.freeze({
      ...(providerCode === undefined ? {} : { providerCode }),
      providerMessage: sanitizedProviderMessage(error.message),
      retryable: retryableProviderFailure(status, providerCode),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  } catch {
    return fallback;
  }
}

function normalizedRequestBody(
  value: string,
  sessionId: string,
  threadId: string,
  wireProtocol: CodexPortRequest['wireProtocol'],
): string {
  let body: unknown;
  try {
    body = JSON.parse(value);
  } catch {
    throw new Error('Invalid experimental model request.');
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          'model',
          'instructions',
          'input',
          'tools',
          'tool_choice',
          'parallel_tool_calls',
          'reasoning',
          'stream',
          'store',
          'include',
          'text',
        ].includes(key),
    ) ||
    !boundedString(body.model, 256) ||
    !Array.isArray(body.input) ||
    body.tool_choice !== 'auto' ||
    typeof body.parallel_tool_calls !== 'boolean' ||
    !isRecord(body.reasoning) ||
    body.reasoning.effort !== 'medium' ||
    body.stream !== true ||
    body.store !== false ||
    !Array.isArray(body.include) ||
    body.include.length !== 1 ||
    body.include[0] !== 'reasoning.encrypted_content' ||
    !isRecord(body.text) ||
    Object.keys(body.text).some((key) => key !== 'verbosity') ||
    body.text.verbosity !== 'low'
  ) {
    throw new Error('Invalid experimental model request.');
  }
  if (wireProtocol === 'classic') {
    if (
      typeof body.instructions !== 'string' ||
      !Array.isArray(body.tools) ||
      !body.parallel_tool_calls ||
      Object.keys(body.reasoning).some((key) => key !== 'effort')
    ) {
      throw new Error('Invalid experimental model request.');
    }
  } else {
    if (
      'instructions' in body ||
      'tools' in body ||
      body.parallel_tool_calls ||
      Object.keys(body.reasoning).some((key) => key !== 'effort' && key !== 'context') ||
      body.reasoning.context !== 'all_turns'
    ) {
      throw new Error('Invalid experimental model request.');
    }
    const additionalTools: unknown = body.input[0];
    const developerMessage: unknown = body.input[1];
    if (
      !isRecord(additionalTools) ||
      additionalTools.type !== 'additional_tools' ||
      additionalTools.role !== 'developer' ||
      !Array.isArray(additionalTools.tools) ||
      !isRecord(developerMessage) ||
      developerMessage.type !== 'message' ||
      developerMessage.role !== 'developer' ||
      !Array.isArray(developerMessage.content)
    ) {
      throw new Error('Invalid experimental Responses Lite request.');
    }
  }
  return JSON.stringify({
    ...body,
    prompt_cache_key: sessionId,
    client_metadata: { session_id: sessionId, thread_id: threadId },
  });
}

function normalizedCompactionBody(
  value: string,
  sessionId: string,
  threadId: string,
  wireProtocol: CodexPortRequest['wireProtocol'],
): string {
  const normalized = normalizedRequestBody(value, sessionId, threadId, wireProtocol);
  const body = JSON.parse(normalized) as { input: unknown[] };
  const trigger = body.input.at(-1);
  if (
    !isRecord(trigger) ||
    trigger.type !== 'compaction_trigger' ||
    Object.keys(trigger).length !== 1 ||
    body.input.slice(0, -1).some((item) => isRecord(item) && item.type === 'compaction_trigger')
  ) {
    throw new Error('Invalid compaction trigger.');
  }
  return normalized;
}

function normalizedCustomBody(source: string): string {
  const body: unknown = JSON.parse(source);
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) =>
        !['model', 'instructions', 'input', 'tools', 'stream', 'reasoning', 'store'].includes(key),
    ) ||
    !boundedString(body.model, 256) ||
    typeof body.instructions !== 'string' ||
    !Array.isArray(body.input) ||
    !Array.isArray(body.tools) ||
    typeof body.stream !== 'boolean' ||
    (body.store !== undefined && body.store !== false)
  )
    throw new Error('Invalid Responses request.');
  if (body.tools.some((tool) => !isRecord(tool) || tool.type !== 'function'))
    throw new Error('Only function tools are supported.');
  return JSON.stringify({ ...body, store: false });
}

function parseModelRequest(value: unknown, custom = false): CodexPortRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'protocol',
          'version',
          'type',
          'requestId',
          'sessionId',
          'threadId',
          'body',
          'wireProtocol',
          ...(custom ? ['connectionId'] : []),
        ].includes(key),
    )
  ) {
    throw new Error('Invalid experimental model request.');
  }
  if (
    value.protocol !== (custom ? CUSTOM_RESPONSES_PROTOCOL : CODEX_MODEL_TRANSPORT_PROTOCOL) ||
    value.version !== CODEX_MODEL_TRANSPORT_VERSION ||
    (custom
      ? value.type !== 'generate' ||
        typeof value.connectionId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.connectionId) ||
        value.wireProtocol !== 'classic'
      : value.type !== 'generate' && value.type !== 'compact') ||
    !headerIdentifier(value.requestId) ||
    !headerIdentifier(value.sessionId) ||
    !headerIdentifier(value.threadId) ||
    (value.wireProtocol !== 'classic' && value.wireProtocol !== 'responses-lite') ||
    !boundedString(value.body, MAXIMUM_REQUEST_BODY_LENGTH)
  ) {
    throw new Error('Invalid experimental model request.');
  }
  const body = custom
    ? normalizedCustomBody(value.body)
    : value.type === 'compact'
      ? normalizedCompactionBody(value.body, value.sessionId, value.threadId, value.wireProtocol)
      : normalizedRequestBody(value.body, value.sessionId, value.threadId, value.wireProtocol);
  if (body.length > MAXIMUM_REQUEST_BODY_LENGTH)
    throw new Error('Normalized model request exceeds the limit.');
  const parsedBody: unknown = JSON.parse(body);
  if (!isRecord(parsedBody) || typeof parsedBody.model !== 'string') {
    throw new Error('Invalid experimental model request.');
  }
  return Object.freeze({
    protocol: custom ? CUSTOM_RESPONSES_PROTOCOL : CODEX_MODEL_TRANSPORT_PROTOCOL,
    ...(custom ? { connectionId: value.connectionId as string } : {}),
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: value.type as CodexPortRequest['type'],
    requestId: value.requestId,
    sessionId: value.sessionId,
    threadId: value.threadId,
    model: parsedBody.model,
    body,
    wireProtocol: value.wireProtocol,
  });
}

function post(port: CodexExternalPort, message: unknown): boolean {
  try {
    port.postMessage(Object.freeze(message));
    return true;
  } catch {
    return false;
  }
}

function isMatchingEndAcknowledgement(value: unknown, requestId: string): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'end-ack' &&
    value.requestId === requestId
  );
}

async function* decodedBody(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = decoder.decode(result.value, { stream: true });
      if (chunk !== '') yield chunk;
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function createCodexModelPortListener(
  options: CreateCodexModelPortListenerOptions,
): (port: CodexExternalPort) => void {
  const authorizer = options.authorizer ?? createOriginAuthorizer(DEVELOPMENT_ALLOWED_ORIGINS);
  return (port) => {
    const custom =
      port.name === CUSTOM_RESPONSES_PORT_NAME && options.customResponses !== undefined;
    if (port.name !== CODEX_MODEL_PORT_NAME && !custom) return;
    report(options.diagnosticSink, { event: 'port.connected', stage: 'port' });
    const abortController = new AbortController();
    let state: 'accepting' | 'running' | 'awaiting-end-ack' | 'closed' = 'accepting';
    let activeRequestId: string | undefined;
    let activeOperation: 'generate' | 'compact' | undefined;
    let endAckTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = custom
      ? setTimeout(() => {
          report(options.diagnosticSink, {
            event: 'request.deadline',
            stage: 'provider',
            ...(activeRequestId === undefined ? {} : { requestId: activeRequestId }),
            operation: 'generate',
            code: 'DEADLINE_EXCEEDED',
            retryable: false,
          });
          post(port, {
            type: 'error',
            requestId: activeRequestId ?? 'invalid-request',
            code: 'DEADLINE_EXCEEDED',
            stage: 'provider',
          });
          cleanup(true, true);
        }, 300_000)
      : undefined;

    const cleanup = (abort: boolean, disconnect: boolean): void => {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(deadlineTimer);
      if (endAckTimer !== undefined) {
        clearTimeout(endAckTimer);
        endAckTimer = undefined;
      }
      port.onMessage.removeListener?.(onMessage);
      port.onDisconnect.removeListener?.(onDisconnect);
      activeRequestId = undefined;
      if (abort) abortController.abort();
      if (!disconnect) return;
      try {
        port.disconnect();
      } catch {
        // The caller may already have disconnected.
      }
    };

    const finishWithEndHandshake = (requestId: string): boolean => {
      if (state !== 'running') return false;
      activeRequestId = requestId;
      state = 'awaiting-end-ack';
      endAckTimer = setTimeout(() => {
        cleanup(false, true);
      }, CODEX_MODEL_END_ACK_TIMEOUT_MS);
      if (!post(port, { type: 'end', requestId })) {
        cleanup(false, true);
      }
      return true;
    };

    function onDisconnect(): void {
      if (state === 'closed') return;
      report(options.diagnosticSink, {
        event: 'port.disconnected',
        stage: 'port',
        ...(activeRequestId === undefined ? {} : { requestId: activeRequestId }),
        ...(activeOperation === undefined ? {} : { operation: activeOperation }),
        retryable: false,
      });
      cleanup(true, false);
    }

    function onMessage(untrustedMessage: unknown): void {
      if (state === 'awaiting-end-ack') {
        if (
          activeRequestId !== undefined &&
          isMatchingEndAcknowledgement(untrustedMessage, activeRequestId)
        ) {
          cleanup(false, true);
        }
        return;
      }
      if (state !== 'accepting') return;
      state = 'running';
      void (async () => {
        let awaitingEndAcknowledgement = false;
        let requestId = 'invalid-request';
        let operation: 'generate' | 'compact' | undefined;
        const diagnostic = (event: CodexModelDiagnosticEvent): void =>
          report(options.diagnosticSink, {
            ...event,
            ...(operation === undefined ? {} : { operation }),
          });
        let stage: CodexModelDiagnosticStage = 'authorization';
        try {
          diagnostic({ event: 'request.received', stage });
          await (custom ? options.customResponses.authorizer : authorizer).assertAuthorized(
            port.sender ?? {},
          );
          diagnostic({ event: 'origin.authorized', stage });
          stage = 'validation';
          const request = parseModelRequest(untrustedMessage, custom);
          requestId = request.requestId;
          operation = request.type;
          activeRequestId = requestId;
          activeOperation = operation;
          diagnostic({
            event: 'request.validated',
            stage,
            requestId,
            characters: request.body.length,
          });
          stage = 'routing';
          let endpoint: string = CODEX_RESPONSES_ENDPOINT;
          let provider: ServerProvider = 'responses';
          let requestBody = request.body;
          let headers: Readonly<Record<string, string>>;
          if (custom && request.connectionId !== undefined) {
            const connection = await options.customResponses.store.authorized(
              request.connectionId,
              port.sender ?? {},
            );
            provider =
              connection.provider === 'claude-code'
                ? 'responses'
                : (connection.provider ?? 'responses');
            const adapted = nativeRequest(connection, request.body);
            endpoint = adapted.endpoint;
            requestBody = adapted.body;
            if (requestBody.length > MAXIMUM_REQUEST_BODY_LENGTH)
              throw new Error('Provider request exceeds limit.');
            headers = Object.freeze({
              'Content-Type': 'application/json',
              Accept: 'text/event-stream, application/json',
              ...serverHeaders(connection),
            });
          } else {
            const accountId = await options.accountRoutingStore.get();
            if (accountId === undefined) throw new Error('ChatGPT account routing is unavailable.');
            diagnostic({ event: 'routing.available', stage, requestId });
            stage = 'authentication';
            diagnostic({ event: 'access-token.requested', stage, requestId });
            const token = await options.tokenService.getAccessToken(options.providerId);
            diagnostic({ event: 'access-token.available', stage, requestId });
            headers = Object.freeze({
              Authorization: `Bearer ${token.accessToken}`,
              'ChatGPT-Account-ID': accountId,
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
              originator: 'loom_extension_experiment',
              'session-id': request.sessionId,
              'thread-id': request.threadId,
              'x-client-request-id': request.requestId,
              version: 'loom.js/0.8.0',
              ...(request.wireProtocol === 'responses-lite'
                ? { 'x-openai-internal-codex-responses-lite': 'true' }
                : {}),
            });
          }
          if (abortController.signal.aborted) return;
          stage = 'provider';
          diagnostic({
            event: 'provider.fetch.started',
            stage,
            requestId,
            characters: request.body.length,
            method: 'POST',
            ...(custom ? {} : { targetHost: 'chatgpt.com' }),
            targetPath: custom
              ? provider === 'anthropic'
                ? '/v1/messages'
                : provider === 'gemini-subscription'
                  ? '/v1internal:generateContent'
                  : provider === 'gemini'
                    ? '/v1beta/models/:model:generateContent'
                    : '/v1/responses'
              : '/backend-api/codex/responses',
            model: request.model,
          });
          const response = await options.fetchRequest(endpoint, {
            method: 'POST',
            headers,
            body: requestBody,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: abortController.signal,
          });
          diagnostic({
            event: 'provider.response.started',
            stage,
            requestId,
            status: response.status,
          });
          const contentType =
            provider !== 'responses'
              ? 'application/json'
              : custom
                ? response.headers?.get('content-type')?.toLowerCase().includes('text/event-stream')
                  ? 'text/event-stream'
                  : 'application/json'
                : undefined;
          if (
            !post(port, {
              type: 'start',
              requestId,
              status: response.status,
              ...(contentType === undefined ? {} : { contentType }),
            })
          )
            return;
          if (response.status < 200 || response.status >= 300) {
            const retryAfterMs = retryAfterMilliseconds(response.headers);
            const receivedMetadata = await readProviderErrorMetadata(
              response.body,
              response.status,
              retryAfterMs,
            );
            const { providerCode, ...safeMetadata } = receivedMetadata;
            const metadata = {
              ...safeMetadata,
              ...(providerCode !== undefined && (!custom || CUSTOM_PROVIDER_CODES.has(providerCode))
                ? { providerCode }
                : {}),
              ...(custom ? { providerMessage: GENERIC_PROVIDER_MESSAGE } : {}),
              ...(request.type === 'compact' && [404, 405, 501].includes(response.status)
                ? { retryable: false }
                : {}),
            };
            diagnostic({
              event: 'provider.response.rejected',
              stage,
              requestId,
              status: response.status,
              ...metadata,
              providerMessage: GENERIC_PROVIDER_MESSAGE,
            });
            post(port, { type: 'provider-error', requestId, status: response.status, ...metadata });
            awaitingEndAcknowledgement = finishWithEndHandshake(requestId);
            return;
          }
          stage = 'stream';
          if (response.body === null) throw new Error('Provider response body is unavailable.');
          let nativeBody = '';
          let chunks = 0;
          let characters = 0;
          for await (const chunk of decodedBody(response.body)) {
            chunks += 1;
            characters += chunk.length;
            if (custom && characters > 8 * 1024 * 1024)
              throw new Error('Responses stream exceeded the limit.');
            diagnostic({
              event: 'provider.response.chunk',
              stage,
              requestId,
              chunks,
              characters: chunk.length,
            });
            if (provider !== 'responses') {
              nativeBody += chunk;
              continue;
            }
            if (!post(port, { type: 'chunk', requestId, chunk })) {
              return;
            }
          }
          if (provider !== 'responses') {
            const chunk = nativeResponse(provider, nativeBody, globalThis.crypto.randomUUID());
            if (chunk.length > 8 * 1024 * 1024)
              throw new Error('Converted response exceeds limit.');
            if (!post(port, { type: 'chunk', requestId, chunk })) return;
          }
          diagnostic({
            event: 'provider.response.completed',
            stage,
            requestId,
            chunks,
            characters,
          });
          awaitingEndAcknowledgement = finishWithEndHandshake(requestId);
        } catch (error) {
          const code =
            custom && stage === 'routing' && !abortController.signal.aborted
              ? 'CONNECTION_UNAVAILABLE'
              : failureCode(stage, abortController.signal.aborted);
          diagnostic({
            event: 'request.failed',
            stage,
            requestId,
            code,
            retryable: code === 'PROVIDER_FETCH_FAILED',
            ...(error instanceof ExtensionBrokerError ? { brokerCode: error.code } : {}),
            ...(error instanceof GoogleSubscriptionError
              ? {
                  providerCode: error.code,
                  ...(error.status === undefined ? {} : { status: error.status }),
                }
              : {}),
          });
          post(port, {
            type: 'error',
            requestId,
            code,
            stage,
            message: abortController.signal.aborted
              ? 'Experimental Codex request was cancelled.'
              : 'Experimental Codex model transport failed.',
          });
        } finally {
          if (!awaitingEndAcknowledgement) cleanup(true, true);
        }
      })();
    }

    port.onDisconnect.addListener(onDisconnect);
    port.onMessage.addListener(onMessage);
  };
}
