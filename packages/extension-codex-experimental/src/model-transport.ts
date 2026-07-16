import {
  createOriginAuthorizer,
  type ExtensionTokenService,
  type OriginAuthorizer,
} from '@loom/extension';

import type { CodexAccountRoutingStore } from './account-routing.js';
import type { CodexExternalPort, CodexModelFetch } from './chrome-contracts.js';
import { DEVELOPMENT_ALLOWED_ORIGINS } from './composition.js';

export const CODEX_MODEL_PORT_NAME = 'loom/codex-model-experimental/v1' as const;
export const CODEX_MODEL_TRANSPORT_PROTOCOL = 'loom/codex-model-experimental' as const;
export const CODEX_MODEL_TRANSPORT_VERSION = 1 as const;
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses' as const;

const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;

interface GenerateRequest {
  readonly protocol: typeof CODEX_MODEL_TRANSPORT_PROTOCOL;
  readonly version: typeof CODEX_MODEL_TRANSPORT_VERSION;
  readonly type: 'generate';
  readonly requestId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly body: string;
}

export interface CreateCodexModelPortListenerOptions {
  readonly providerId: string;
  readonly tokenService: ExtensionTokenService;
  readonly accountRoutingStore: CodexAccountRoutingStore;
  readonly fetchRequest: CodexModelFetch;
  readonly authorizer?: OriginAuthorizer;
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

function normalizedRequestBody(value: string): string {
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
          'stream',
          'store',
          'include',
        ].includes(key),
    ) ||
    !boundedString(body.model, 256) ||
    typeof body.instructions !== 'string' ||
    !Array.isArray(body.input) ||
    !Array.isArray(body.tools) ||
    body.tool_choice !== 'auto' ||
    body.parallel_tool_calls !== true ||
    body.stream !== true ||
    body.store !== false ||
    !Array.isArray(body.include) ||
    body.include.length !== 1 ||
    body.include[0] !== 'reasoning.encrypted_content'
  ) {
    throw new Error('Invalid experimental model request.');
  }
  return JSON.stringify(body);
}

function parseGenerateRequest(value: unknown): GenerateRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !['protocol', 'version', 'type', 'requestId', 'sessionId', 'threadId', 'body'].includes(
          key,
        ),
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
    !boundedString(value.body, MAXIMUM_REQUEST_BODY_LENGTH)
  ) {
    throw new Error('Invalid experimental model request.');
  }
  return Object.freeze({
    protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
    version: CODEX_MODEL_TRANSPORT_VERSION,
    type: 'generate',
    requestId: value.requestId,
    sessionId: value.sessionId,
    threadId: value.threadId,
    body: normalizedRequestBody(value.body),
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
    const abortController = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => abortController.abort());
    port.onMessage.addListener((untrustedMessage) => {
      if (started) return;
      started = true;
      void (async () => {
        let requestId = 'invalid-request';
        try {
          authorizer.assertAuthorized(port.sender ?? {});
          const request = parseGenerateRequest(untrustedMessage);
          requestId = request.requestId;
          const accountId = await options.accountRoutingStore.get();
          if (accountId === undefined) {
            throw new Error('ChatGPT account routing is unavailable.');
          }
          const token = await options.tokenService.getAccessToken(options.providerId);
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
            }),
            body: request.body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: abortController.signal,
          });
          if (!post(port, { type: 'start', requestId, status: response.status })) return;
          if (response.status < 200 || response.status >= 300) {
            post(port, { type: 'end', requestId });
            return;
          }
          if (response.body === null) throw new Error('Provider response body is unavailable.');
          for await (const chunk of decodedBody(response.body)) {
            if (
              abortController.signal.aborted ||
              !post(port, { type: 'chunk', requestId, chunk })
            ) {
              return;
            }
          }
          post(port, { type: 'end', requestId });
        } catch {
          post(port, {
            type: 'error',
            requestId,
            code: abortController.signal.aborted ? 'CANCELLED' : 'MODEL_REQUEST_FAILED',
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
