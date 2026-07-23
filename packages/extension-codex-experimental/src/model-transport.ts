import {
  createOriginAuthorizer,
  ExtensionBrokerError,
  type ExtensionTokenService,
  type OriginAuthorizer,
} from '@mgravey/loom-extension';
import type { CodexAccountRoutingStore } from './account-routing.js';
import type { CodexExternalPort, CodexModelFetch } from './chrome-contracts.js';
import { DEVELOPMENT_ALLOWED_ORIGINS } from './composition.js';

export const CODEX_MODEL_PORT_NAME = 'loom/codex-model-experimental/v1' as const;
export const CODEX_MODEL_TRANSPORT_PROTOCOL = 'loom/codex-model-experimental' as const;
export const CODEX_MODEL_TRANSPORT_VERSION = 1 as const;
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses' as const;
export const CODEX_RESPONSES_COMPACT_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses/compact' as const;

const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_PROVIDER_ERROR_BODY_LENGTH = 16 * 1024;
const MAXIMUM_PROVIDER_MESSAGE_LENGTH = 512;
const MAXIMUM_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const GENERIC_PROVIDER_MESSAGE = 'The provider rejected the request.';
const NON_RETRYABLE_PROVIDER_CODE =
  /(account|auth|billing|credit|forbidden|insufficient_quota|invalid|payment|permission|policy|quota_exceeded|restricted|unauthorized)/u;

interface CodexPortRequest {
  readonly protocol: typeof CODEX_MODEL_TRANSPORT_PROTOCOL;
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
    const providerCode = providerIdentifier(error.code);
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
  wireProtocol: CodexPortRequest['wireProtocol'],
): string {
  let body: unknown;
  try {
    body = JSON.parse(value);
  } catch {
    throw new Error('Invalid experimental compaction request.');
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          'model',
          'input',
          'instructions',
          'tools',
          'parallel_tool_calls',
          'reasoning',
          'text',
        ].includes(key),
    ) ||
    !boundedString(body.model, 256) ||
    !Array.isArray(body.input) ||
    typeof body.instructions !== 'string' ||
    !Array.isArray(body.tools) ||
    typeof body.parallel_tool_calls !== 'boolean' ||
    !isRecord(body.reasoning) ||
    body.reasoning.effort !== 'medium' ||
    !isRecord(body.text) ||
    Object.keys(body.text).some((key) => key !== 'verbosity') ||
    body.text.verbosity !== 'low'
  ) {
    throw new Error('Invalid experimental compaction request.');
  }
  if (
    wireProtocol === 'classic'
      ? !body.parallel_tool_calls || Object.keys(body.reasoning).some((key) => key !== 'effort')
      : body.parallel_tool_calls ||
        Object.keys(body.reasoning).some((key) => key !== 'effort' && key !== 'context') ||
        body.reasoning.context !== 'all_turns'
  ) {
    throw new Error('Invalid experimental compaction request.');
  }
  return JSON.stringify({
    ...body,
    prompt_cache_key: sessionId,
  });
}

function parseModelRequest(value: unknown): CodexPortRequest {
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
        ].includes(key),
    )
  ) {
    throw new Error('Invalid experimental model request.');
  }
  if (
    value.protocol !== CODEX_MODEL_TRANSPORT_PROTOCOL ||
    value.version !== CODEX_MODEL_TRANSPORT_VERSION ||
    (value.type !== 'generate' && value.type !== 'compact') ||
    !headerIdentifier(value.requestId) ||
    !headerIdentifier(value.sessionId) ||
    !headerIdentifier(value.threadId) ||
    (value.wireProtocol !== 'classic' && value.wireProtocol !== 'responses-lite') ||
    !boundedString(value.body, MAXIMUM_REQUEST_BODY_LENGTH)
  ) {
    throw new Error('Invalid experimental model request.');
  }
  const body =
    value.type === 'compact'
      ? normalizedCompactionBody(value.body, value.sessionId, value.wireProtocol)
      : normalizedRequestBody(value.body, value.sessionId, value.threadId, value.wireProtocol);
  const parsedBody: unknown = JSON.parse(body);
  if (!isRecord(parsedBody) || typeof parsedBody.model !== 'string') {
    throw new Error('Invalid experimental model request.');
  }
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: value.type,
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
    if (port.name !== CODEX_MODEL_PORT_NAME) return;
    report(options.diagnosticSink, { event: 'port.connected', stage: 'port' });
    const abortController = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => {
      report(options.diagnosticSink, { event: 'port.disconnected', stage: 'port' });
      abortController.abort();
    });
    port.onMessage.addListener((untrustedMessage) => {
      if (started) return;
      started = true;
      void (async () => {
        let requestId = 'invalid-request';
        let stage: CodexModelDiagnosticStage = 'authorization';
        try {
          report(options.diagnosticSink, { event: 'request.received', stage });
          await authorizer.assertAuthorized(port.sender ?? {});
          report(options.diagnosticSink, { event: 'origin.authorized', stage });
          stage = 'validation';
          const request = parseModelRequest(untrustedMessage);
          requestId = request.requestId;
          report(options.diagnosticSink, {
            event: 'request.validated',
            stage,
            requestId,
            characters: request.body.length,
          });
          stage = 'routing';
          const accountId = await options.accountRoutingStore.get();
          if (accountId === undefined) {
            throw new Error('ChatGPT account routing is unavailable.');
          }
          report(options.diagnosticSink, { event: 'routing.available', stage, requestId });
          stage = 'authentication';
          report(options.diagnosticSink, { event: 'access-token.requested', stage, requestId });
          const token = await options.tokenService.getAccessToken(options.providerId);
          report(options.diagnosticSink, { event: 'access-token.available', stage, requestId });
          stage = 'provider';
          report(options.diagnosticSink, {
            event: 'provider.fetch.started',
            stage,
            requestId,
            characters: request.body.length,
            method: 'POST',
            targetHost: 'chatgpt.com',
            targetPath:
              request.type === 'compact'
                ? '/backend-api/codex/responses/compact'
                : '/backend-api/codex/responses',
            model: request.model,
          });
          const response = await options.fetchRequest(
            request.type === 'compact'
              ? CODEX_RESPONSES_COMPACT_ENDPOINT
              : CODEX_RESPONSES_ENDPOINT,
            {
              method: 'POST',
              headers: Object.freeze({
                Authorization: `Bearer ${token.accessToken}`,
                'ChatGPT-Account-ID': accountId,
                Accept: request.type === 'compact' ? 'application/json' : 'text/event-stream',
                'Content-Type': 'application/json',
                originator: 'loom_extension_experiment',
                'session-id': request.sessionId,
                'thread-id': request.threadId,
                'x-client-request-id': request.requestId,
                version: 'loom.js/0.2.0',
                ...(request.wireProtocol === 'responses-lite'
                  ? { 'x-openai-internal-codex-responses-lite': 'true' }
                  : {}),
              }),
              body: request.body,
              cache: 'no-store',
              credentials: 'omit',
              redirect: 'error',
              signal: abortController.signal,
            },
          );
          report(options.diagnosticSink, {
            event: 'provider.response.started',
            stage,
            requestId,
            status: response.status,
          });
          if (!post(port, { type: 'start', requestId, status: response.status })) return;
          if (response.status < 200 || response.status >= 300) {
            const retryAfterMs = retryAfterMilliseconds(response.headers);
            const metadata = await readProviderErrorMetadata(
              response.body,
              response.status,
              retryAfterMs,
            );
            report(options.diagnosticSink, {
              event: 'provider.response.rejected',
              stage,
              requestId,
              status: response.status,
              ...metadata,
            });
            post(port, { type: 'provider-error', requestId, status: response.status, ...metadata });
            post(port, { type: 'end', requestId });
            return;
          }
          stage = 'stream';
          if (response.body === null) throw new Error('Provider response body is unavailable.');
          let chunks = 0;
          let characters = 0;
          for await (const chunk of decodedBody(response.body)) {
            chunks += 1;
            characters += chunk.length;
            report(options.diagnosticSink, {
              event: 'provider.response.chunk',
              stage,
              requestId,
              chunks,
              characters: chunk.length,
            });
            if (
              abortController.signal.aborted ||
              !post(port, { type: 'chunk', requestId, chunk })
            ) {
              return;
            }
          }
          report(options.diagnosticSink, {
            event: 'provider.response.completed',
            stage,
            requestId,
            chunks,
            characters,
          });
          post(port, { type: 'end', requestId });
        } catch (error) {
          const code = failureCode(stage, abortController.signal.aborted);
          report(options.diagnosticSink, {
            event: 'request.failed',
            stage,
            requestId,
            code,
            ...(error instanceof ExtensionBrokerError ? { brokerCode: error.code } : {}),
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
          try {
            port.disconnect();
          } catch {
            // The caller may already have disconnected.
          }
        }
      })();
    });
  };
}
