import type { CodexOriginAccessStatus, RequestCodexOriginAccessOptions } from './contracts.js';
import { CodexCompanionError } from './errors.js';
import {
  CODEX_ORIGIN_ACCESS_PROTOCOL,
  CODEX_ORIGIN_ACCESS_VERSION,
  LOOM_COMPANION_EXTENSION_ID,
  isRecord,
  report,
  resolveIdentifier,
  resolveRuntime,
  validateRequestIdFactory,
} from './shared.js';

function sendExternalMessage(
  options: RequestCodexOriginAccessOptions,
  message: unknown,
): Promise<unknown> {
  const runtime = resolveRuntime(options.runtime);
  const extensionId = resolveIdentifier(
    options.extensionId ?? LOOM_COMPANION_EXTENSION_ID,
    'extension ID',
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (): void => {
      if (settled) return;
      settled = true;
      reject(
        new CodexCompanionError(
          'ORIGIN_ACCESS_FAILED',
          'The Loom.js Companion could not check website access.',
        ),
      );
    };
    try {
      const returned = runtime.sendMessage(extensionId, message, undefined, (response) => {
        if (runtime.lastError !== undefined) rejectOnce();
        else resolveOnce(response);
      });
      if (
        returned !== null &&
        (typeof returned === 'object' || typeof returned === 'function') &&
        typeof (returned as PromiseLike<unknown>).then === 'function'
      ) {
        void Promise.resolve(returned as PromiseLike<unknown>).then(resolveOnce, rejectOnce);
      } else if (returned !== undefined) {
        resolveOnce(returned);
      }
    } catch {
      rejectOnce();
    }
  });
}

export function createCodexOriginAccessRequester(
  options: RequestCodexOriginAccessOptions,
): () => Promise<CodexOriginAccessStatus> {
  if (!isRecord(options)) {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      'Loom companion origin-access options are required.',
    );
  }
  const requestIdFactory = validateRequestIdFactory(options.requestIdFactory, 'loom-origin-access');
  return async () => {
    const requestId = requestIdFactory();
    report(options.diagnosticSink, {
      event: 'origin.access.requested',
      stage: 'origin-access',
      requestId,
    });
    const response = await sendExternalMessage(options, {
      protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
      version: CODEX_ORIGIN_ACCESS_VERSION,
      type: 'requestOriginAccess',
      requestId,
    });
    if (
      !isRecord(response) ||
      response.protocol !== CODEX_ORIGIN_ACCESS_PROTOCOL ||
      response.version !== CODEX_ORIGIN_ACCESS_VERSION ||
      response.type !== 'originAccessResult' ||
      response.requestId !== requestId ||
      response.ok !== true ||
      typeof response.approved !== 'boolean'
    ) {
      const remoteCode =
        isRecord(response) && isRecord(response.error) && typeof response.error.code === 'string'
          ? response.error.code
          : undefined;
      report(options.diagnosticSink, {
        event: 'origin.access.failed',
        stage: 'origin-access',
        requestId,
        ...(remoteCode === undefined ? {} : { code: remoteCode }),
      });
      throw new CodexCompanionError(
        'ORIGIN_ACCESS_FAILED',
        'The Loom.js Companion rejected the website access request.',
        { ...(remoteCode === undefined ? {} : { remoteCode }) },
      );
    }
    report(options.diagnosticSink, {
      event: 'origin.access.completed',
      stage: 'origin-access',
      requestId,
      code: response.approved ? 'APPROVED' : 'APPROVAL_REQUIRED',
    });
    return Object.freeze({ approved: response.approved });
  };
}

export async function requestCodexOriginAccess(
  options: RequestCodexOriginAccessOptions,
): Promise<CodexOriginAccessStatus> {
  return createCodexOriginAccessRequester(options)();
}

export async function ensureCodexOriginAccess(
  options: RequestCodexOriginAccessOptions,
): Promise<void> {
  if (!(await requestCodexOriginAccess(options)).approved) {
    throw new CodexCompanionError(
      'ORIGIN_APPROVAL_REQUIRED',
      'Approve this exact website origin in the Loom.js Companion options, then retry.',
    );
  }
}
