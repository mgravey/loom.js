import type {
  CodexResponsesFetch,
  CodexResponsesHttpResponse,
  CodexResponsesRequest,
  CodexResponsesTransport,
} from '@mgravey/loom-model-codex-experimental';
import {
  CODEX_PROVIDER_MESSAGE_MAXIMUM_LENGTH,
  GENERIC_CODEX_PROVIDER_MESSAGE,
  isRetryableProviderFailure,
  sanitizeCodexProviderMessage,
  validCodexRetryAfterMs,
} from '@mgravey/loom-model-codex-experimental';

import type { CodexCompanionPort, CreateCodexExtensionTransportOptions } from './contracts.js';
import { CodexCompanionError } from './errors.js';
import {
  CODEX_MODEL_PORT_NAME,
  CODEX_MODEL_TRANSPORT_PROTOCOL,
  CODEX_MODEL_TRANSPORT_VERSION,
  LOOM_COMPANION_EXTENSION_ID,
  isRecord,
  report,
  resolveIdentifier,
  resolveRuntime,
  validateRequestIdFactory,
} from './shared.js';

const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;
const PROVIDER_CODE_PATTERN = /^[a-zA-Z0-9._:[\]-]{1,256}$/u;

interface ValidatedProviderError {
  readonly providerCode?: string;
  readonly providerMessage: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

function validateProviderError(
  message: Readonly<Record<string, unknown>>,
  status: number,
): ValidatedProviderError {
  const providerCode =
    typeof message.providerCode === 'string' && PROVIDER_CODE_PATTERN.test(message.providerCode)
      ? message.providerCode
      : undefined;
  const providerMessage =
    typeof message.providerMessage === 'string' &&
    message.providerMessage.length <= CODEX_PROVIDER_MESSAGE_MAXIMUM_LENGTH
      ? sanitizeCodexProviderMessage(message.providerMessage)
      : GENERIC_CODEX_PROVIDER_MESSAGE;
  const classifiedRetryable = isRetryableProviderFailure(status, providerCode);
  const retryable =
    message.retryable === undefined
      ? classifiedRetryable
      : typeof message.retryable === 'boolean' && message.retryable === classifiedRetryable
        ? message.retryable
        : false;
  const retryAfterMs = validCodexRetryAfterMs(message.retryAfterMs);
  return Object.freeze({
    ...(providerCode === undefined ? {} : { providerCode }),
    providerMessage,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function createChunkStream(): {
  readonly body: AsyncIterable<string>;
  push(chunk: string): void;
  finish(): void;
  fail(error: Error): void;
} {
  const chunks: string[] = [];
  const waiters: (() => void)[] = [];
  let finished = false;
  let failure: Error | undefined;
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return Object.freeze({
    body: Object.freeze({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = chunks.shift();
          if (chunk !== undefined) {
            yield chunk;
            continue;
          }
          if (failure !== undefined) throw failure;
          if (finished) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    }),
    push(chunk: string) {
      if (!finished && failure === undefined) chunks.push(chunk);
      wake();
    },
    finish() {
      if (failure !== undefined) return;
      finished = true;
      wake();
    },
    fail(error: Error) {
      if (finished || failure !== undefined) return;
      failure = error;
      wake();
    },
  });
}

function transportError(
  code: 'CONNECTION_FAILED' | 'INVALID_RESPONSE' | 'EXTENSION_REQUEST_FAILED' | 'CANCELLED',
  message: string,
  remoteCode?: string,
): CodexCompanionError {
  return new CodexCompanionError(code, message, {
    ...(remoteCode === undefined ? {} : { remoteCode }),
  });
}

function safeDisconnect(port: CodexCompanionPort): void {
  try {
    port.disconnect();
  } catch {
    // The extension may already have closed the port.
  }
}

function sendThroughPort(
  options: CreateCodexExtensionTransportOptions,
  requestId: string,
  request: CodexResponsesRequest,
): Promise<CodexResponsesHttpResponse> {
  request.signal?.throwIfCancelled();
  const wireProtocol: unknown = request.wireProtocol;
  const operation: unknown = request.operation ?? 'generate';
  if (
    typeof request.body !== 'string' ||
    request.body.trim() === '' ||
    request.body.length > MAXIMUM_REQUEST_BODY_LENGTH ||
    (operation !== 'generate' && operation !== 'compact') ||
    (wireProtocol !== 'classic' && wireProtocol !== 'responses-lite')
  ) {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      'The Loom companion model request is invalid or exceeds the 4 MiB limit.',
    );
  }

  const runtime = resolveRuntime(options.runtime);
  const extensionId = resolveIdentifier(
    options.extensionId ?? LOOM_COMPANION_EXTENSION_ID,
    'extension ID',
  );
  const sessionId = resolveIdentifier(options.sessionId, 'session ID');
  const threadId = resolveIdentifier(options.threadId ?? sessionId, 'thread ID');
  let port: CodexCompanionPort;
  try {
    port = runtime.connect(extensionId, { name: CODEX_MODEL_PORT_NAME });
  } catch {
    throw transportError(
      'CONNECTION_FAILED',
      'Could not connect to the Loom.js Companion model relay.',
    );
  }

  const stream = createChunkStream();
  let responseStarted = false;
  let responseStatus: number | undefined;
  let ended = false;
  let settled = false;
  let unsubscribe = (): void => undefined;
  report(options.diagnosticSink, {
    event: 'model.connection.opened',
    stage: 'connection',
    requestId,
  });

  return new Promise((resolve, reject) => {
    const fail = (error: CodexCompanionError): void => {
      unsubscribe();
      if (settled) stream.fail(error);
      else {
        settled = true;
        reject(error);
      }
      safeDisconnect(port);
    };
    const invalidResponse = (): void => {
      report(options.diagnosticSink, {
        event: 'model.response.invalid',
        stage: 'response',
        requestId,
        code: 'INVALID_RESPONSE',
      });
      fail(
        transportError(
          'INVALID_RESPONSE',
          'The Loom.js Companion returned an invalid model response.',
        ),
      );
    };

    port.onMessage.addListener((message) => {
      if (!isRecord(message) || message.requestId !== requestId) return;
      if (
        message.type === 'start' &&
        Number.isInteger(message.status) &&
        typeof message.status === 'number' &&
        message.status >= 100 &&
        message.status <= 599 &&
        !responseStarted
      ) {
        responseStarted = true;
        responseStatus = message.status;
        report(options.diagnosticSink, {
          event: 'model.response.started',
          stage: 'response',
          requestId,
          status: message.status,
        });
        if (message.status >= 200 && message.status < 300) {
          settled = true;
          resolve(Object.freeze({ status: message.status, body: stream.body }));
        }
        return;
      }
      if (
        message.type === 'chunk' &&
        typeof message.chunk === 'string' &&
        responseStarted &&
        responseStatus !== undefined &&
        responseStatus >= 200 &&
        responseStatus < 300
      ) {
        report(options.diagnosticSink, {
          event: 'model.response.chunk',
          stage: 'stream',
          requestId,
          characters: message.chunk.length,
        });
        stream.push(message.chunk);
        return;
      }
      if (message.type === 'provider-error' && responseStarted) {
        if (
          responseStatus === undefined ||
          (responseStatus >= 200 && responseStatus < 300) ||
          typeof message.status !== 'number' ||
          !Number.isInteger(message.status) ||
          message.status !== responseStatus
        ) {
          invalidResponse();
          return;
        }
        const metadata = validateProviderError(message, responseStatus);
        report(options.diagnosticSink, {
          event: 'model.provider.rejected',
          stage: 'response',
          requestId,
          status: responseStatus,
          ...(metadata.providerCode === undefined ? {} : { code: metadata.providerCode }),
          providerMessage: metadata.providerMessage,
          retryable: metadata.retryable,
          ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
        });
        settled = true;
        resolve(
          Object.freeze({
            status: responseStatus,
            body: stream.body,
            ...metadata,
          }),
        );
        return;
      }
      if (message.type === 'end' && responseStarted) {
        ended = true;
        unsubscribe();
        report(options.diagnosticSink, {
          event: 'model.response.completed',
          stage: 'stream',
          requestId,
        });
        if (!settled && responseStatus !== undefined) {
          settled = true;
          resolve(
            Object.freeze({
              status: responseStatus,
              body: stream.body,
              providerMessage: GENERIC_CODEX_PROVIDER_MESSAGE,
              retryable: isRetryableProviderFailure(responseStatus),
            }),
          );
        }
        stream.finish();
        return;
      }
      if (message.type === 'error') {
        const remoteCode =
          typeof message.code === 'string' ? message.code.slice(0, 256) : undefined;
        report(options.diagnosticSink, {
          event: 'model.response.failed',
          stage: 'response',
          requestId,
          ...(remoteCode === undefined ? {} : { code: remoteCode }),
        });
        fail(
          transportError(
            remoteCode === 'CANCELLED' ? 'CANCELLED' : 'EXTENSION_REQUEST_FAILED',
            remoteCode === 'UNAUTHORIZED_ORIGIN'
              ? 'This website origin is not approved in the Loom.js Companion.'
              : 'The Loom.js Companion model relay failed.',
            remoteCode,
          ),
        );
        return;
      }
      invalidResponse();
    });

    port.onDisconnect.addListener(() => {
      unsubscribe();
      report(options.diagnosticSink, {
        event: 'model.connection.closed',
        stage: 'cleanup',
        requestId,
        code: ended ? 'COMPLETED' : 'DISCONNECTED',
      });
      if (!ended) {
        fail(
          transportError(
            'CONNECTION_FAILED',
            'The Loom.js Companion model relay disconnected before completion.',
          ),
        );
      }
    });

    if (request.signal !== undefined) {
      unsubscribe = request.signal.onCancel(() => {
        report(options.diagnosticSink, {
          event: 'model.request.cancelled',
          stage: 'cleanup',
          requestId,
          code: 'CANCELLED',
        });
        fail(transportError('CANCELLED', 'The Loom companion model request was cancelled.'));
      });
    }

    report(options.diagnosticSink, {
      event: 'model.request.sent',
      stage: 'request',
      requestId,
      characters: request.body.length,
    });
    try {
      port.postMessage(
        Object.freeze({
          protocol: CODEX_MODEL_TRANSPORT_PROTOCOL,
          version: CODEX_MODEL_TRANSPORT_VERSION,
          type: operation,
          requestId,
          sessionId,
          threadId,
          body: request.body,
          wireProtocol,
        }),
      );
    } catch {
      fail(
        transportError(
          'CONNECTION_FAILED',
          'Could not send the model request to the Loom.js Companion.',
        ),
      );
    }
  });
}

export function createCodexExtensionTransport(
  options: CreateCodexExtensionTransportOptions,
): CodexResponsesTransport {
  if (!isRecord(options)) {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      'Loom companion model transport options are required.',
    );
  }
  if (
    (typeof options.runtime !== 'object' && typeof options.runtime !== 'function') ||
    (typeof options.sessionId !== 'string' && typeof options.sessionId !== 'function')
  ) {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      'Loom companion runtime and session ID are required.',
    );
  }
  const requestIdFactory = validateRequestIdFactory(options.requestIdFactory, 'loom-model');
  return Object.freeze({
    send(request: CodexResponsesRequest) {
      return sendThroughPort(options, requestIdFactory(), request);
    },
  });
}

export function createCodexExtensionFetch(
  options: CreateCodexExtensionTransportOptions,
): CodexResponsesFetch {
  const transport = createCodexExtensionTransport(options);
  return (request) =>
    transport.send({
      body: request.body,
      operation: request.operation ?? (request.url.endsWith('/compact') ? 'compact' : 'generate'),
      wireProtocol:
        request.headers['x-openai-internal-codex-responses-lite'] === 'true'
          ? 'responses-lite'
          : 'classic',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
}
