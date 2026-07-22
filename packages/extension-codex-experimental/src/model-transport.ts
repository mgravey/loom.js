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

const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_PROVIDER_ERROR_BODY_LENGTH = 16 * 1024;

interface GenerateRequest {
  readonly protocol: typeof CODEX_MODEL_TRANSPORT_PROTOCOL;
  readonly version: typeof CODEX_MODEL_TRANSPORT_VERSION;
  readonly type: 'generate';
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
  readonly providerType?: string;
  readonly providerParam?: string;
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

interface ProviderErrorMetadata {
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly providerParam?: string;
}

async function readProviderErrorMetadata(
  body: ReadableStream<Uint8Array> | null,
): Promise<ProviderErrorMetadata> {
  if (body === null) return Object.freeze({});
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
        return Object.freeze({});
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return Object.freeze({});
  } finally {
    reader.releaseLock();
  }

  try {
    const envelope: unknown = JSON.parse(text);
    const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;
    if (error === undefined) return Object.freeze({});
    const providerCode = providerIdentifier(error.code);
    const providerType = providerIdentifier(error.type);
    const providerParam = providerIdentifier(error.param);
    return Object.freeze({
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(providerType === undefined ? {} : { providerType }),
      ...(providerParam === undefined ? {} : { providerParam }),
    });
  } catch {
    return Object.freeze({});
  }
}

function normalizedRequestBody(
  value: string,
  sessionId: string,
  threadId: string,
  wireProtocol: GenerateRequest['wireProtocol'],
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

function parseGenerateRequest(value: unknown): GenerateRequest {
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
    value.type !== 'generate' ||
    !headerIdentifier(value.requestId) ||
    !headerIdentifier(value.sessionId) ||
    !headerIdentifier(value.threadId) ||
    (value.wireProtocol !== 'classic' && value.wireProtocol !== 'responses-lite') ||
    !boundedString(value.body, MAXIMUM_REQUEST_BODY_LENGTH)
  ) {
    throw new Error('Invalid experimental model request.');
  }
  const body = normalizedRequestBody(
    value.body,
    value.sessionId,
    value.threadId,
    value.wireProtocol,
  );
  const parsedBody: unknown = JSON.parse(body);
  if (!isRecord(parsedBody) || typeof parsedBody.model !== 'string') {
    throw new Error('Invalid experimental model request.');
  }
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: 'generate',
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
          const request = parseGenerateRequest(untrustedMessage);
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
            targetPath: '/backend-api/codex/responses',
            model: request.model,
          });
          const response = await options.fetchRequest(CODEX_RESPONSES_ENDPOINT, {
            method: 'POST',
            headers: Object.freeze({
              Authorization: `Bearer ${token.accessToken}`,
              'ChatGPT-Account-ID': accountId,
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
              originator: 'loom_extension_experiment',
              'session-id': request.sessionId,
              'thread-id': request.threadId,
              'x-client-request-id': request.requestId,
              version: 'loom.js/0.1.0',
              ...(request.wireProtocol === 'responses-lite'
                ? { 'x-openai-internal-codex-responses-lite': 'true' }
                : {}),
            }),
            body: request.body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: abortController.signal,
          });
          report(options.diagnosticSink, {
            event: 'provider.response.started',
            stage,
            requestId,
            status: response.status,
          });
          if (!post(port, { type: 'start', requestId, status: response.status })) return;
          if (response.status < 200 || response.status >= 300) {
            const metadata = await readProviderErrorMetadata(response.body);
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
