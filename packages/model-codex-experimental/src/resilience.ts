import { createCancellationSource } from '@mgravey/loom-types';
import type { OperationContext } from '@mgravey/loom-plugin-api';
import { CodexExperimentalModelError, type CodexProviderFailureDetails } from './errors.js';
import { boundedCodexProviderString, validCodexRetryAfterMs } from './provider-failure.js';

/** Only structural, allowlisted metadata crosses the model boundary. Never retain raw errors. */
export function transportFailure(
  error: unknown,
  operation: 'generate' | 'compact',
  stage: string,
): CodexExperimentalModelError {
  if (error instanceof CodexExperimentalModelError) return error;
  const value =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const codes = [
    'CONNECTION_FAILED',
    'EXTENSION_UNAVAILABLE',
    'INVALID_RESPONSE',
    'EXTENSION_REQUEST_FAILED',
    'CANCELLED',
    'ORIGIN_APPROVAL_REQUIRED',
    'ORIGIN_ACCESS_FAILED',
  ];
  const remotes = [
    'CANCELLED',
    'UNAUTHORIZED_ORIGIN',
    'INVALID_REQUEST',
    'ACCOUNT_ROUTING_UNAVAILABLE',
    'AUTHENTICATION_FAILED',
    'PROVIDER_FETCH_FAILED',
    'PROVIDER_STREAM_FAILED',
  ];
  const remoteCode =
    typeof value.remoteCode === 'string' && remotes.includes(value.remoteCode)
      ? value.remoteCode
      : undefined;
  const code =
    typeof value.code === 'string' && codes.includes(value.code) ? value.code : undefined;
  const requestId = boundedCodexProviderString(value.requestId);
  const status =
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599
      ? value.status
      : undefined;
  const details: CodexProviderFailureDetails & { readonly status?: number } = {
    operation,
    ...(status === undefined ? {} : { status }),
    stage: boundedCodexProviderString(value.stage) ?? stage,
    ...(requestId === undefined ? {} : { requestId }),
    ...(remoteCode === undefined ? {} : { remoteCode }),
    retryable: remoteCode === 'PROVIDER_FETCH_FAILED',
    cause: Object.freeze({
      ...(code === undefined ? {} : { code }),
      ...(remoteCode === undefined ? {} : { remoteCode }),
    }),
  };
  const classification =
    remoteCode === 'AUTHENTICATION_FAILED'
      ? 'AUTHENTICATION_FAILED'
      : code === 'CANCELLED' || remoteCode === 'CANCELLED'
        ? 'CANCELLED'
        : code === 'CONNECTION_FAILED' || code === 'EXTENSION_UNAVAILABLE'
          ? 'EXTENSION_DISCONNECTED'
          : code === 'INVALID_RESPONSE'
            ? 'MALFORMED_RESPONSE'
            : 'TRANSPORT_FAILED';
  return new CodexExperimentalModelError(
    classification,
    'Codex transport operation failed.',
    details,
  );
}

/** One deadline covers sending, consuming, and backoff; child cancellation closes the relay port. */
export async function compactWithBudget<T>(
  run: (context: OperationContext) => Promise<T>,
  context: OperationContext | undefined,
  timeoutMs: number,
): Promise<T> {
  context?.signal?.throwIfCancelled();
  const source = createCancellationSource();
  const unsubscribe = context?.signal?.onCancel(() => source.cancel()) ?? (() => undefined);
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    source.cancel();
  }, timeoutMs);
  let removeCancel = (): void => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    removeCancel = source.signal.onCancel(() =>
      reject(
        new CodexExperimentalModelError(
          expired ? 'DEADLINE_EXCEEDED' : 'CANCELLED',
          expired
            ? 'Codex compaction deadline expired; the original context is intact.'
            : 'Codex compaction was cancelled.',
          { operation: 'compact', stage: 'deadline', retryable: false },
        ),
      ),
    );
  });
  try {
    return await Promise.race([run({ ...context, signal: source.signal }), cancelled]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    removeCancel();
    source.cancel();
  }
}

export function retryDelay(error: CodexExperimentalModelError, attempt: number): number {
  return Math.max(
    validCodexRetryAfterMs(error.retryAfterMs) ?? 0,
    Math.floor(250 * 2 ** attempt * (0.5 + Math.random())),
  );
}

export async function waitForRetry(milliseconds: number, context: OperationContext): Promise<void> {
  context.signal?.throwIfCancelled();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, milliseconds);
    const unsubscribe =
      context.signal?.onCancel(() => {
        clearTimeout(timer);
        reject(
          new CodexExperimentalModelError('CANCELLED', 'Codex retry cancelled.', {
            retryable: false,
          }),
        );
      }) ?? (() => undefined);
  });
}
