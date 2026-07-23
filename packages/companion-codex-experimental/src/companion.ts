import {
  createExtensionAuthPlugin,
  createExtensionAuthProvider,
  createExternalCredentialBroker,
} from '@mgravey/loom-auth-extension';
import type { CodexResponsesFetch } from '@mgravey/loom-model-codex-experimental';

import type { CodexCompanion, CreateCodexCompanionOptions } from './contracts.js';
import { CodexCompanionError } from './errors.js';
import { createCodexOriginAccessRequester } from './origin-access.js';
import {
  CODEX_COMPANION_PROVIDER_ID,
  LOOM_COMPANION_EXTENSION_ID,
  isRecord,
  resolveIdentifier,
  resolveRuntime,
} from './shared.js';
import { createCodexExtensionTransport } from './transport.js';

export function createCodexCompanion(options: CreateCodexCompanionOptions): CodexCompanion {
  if (!isRecord(options)) {
    throw new CodexCompanionError('INVALID_CONFIGURATION', 'Loom companion options are required.');
  }
  const extensionId = options.extensionId ?? LOOM_COMPANION_EXTENSION_ID;
  const runtime = resolveRuntime(options.runtime);
  const broker = createExternalCredentialBroker({
    extensionId: resolveIdentifier(extensionId, 'extension ID'),
    runtime,
  });
  const authOptions = Object.freeze({
    broker,
    providerId: CODEX_COMPANION_PROVIDER_ID,
  });
  const requestOriginAccess = createCodexOriginAccessRequester({
    extensionId,
    runtime,
    ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
  });
  const transportOptions: CreateCodexCompanionOptions = {
    extensionId,
    runtime,
    sessionId: options.sessionId,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.requestIdFactory === undefined
      ? {}
      : { requestIdFactory: options.requestIdFactory }),
    ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
  };

  const transport = createCodexExtensionTransport(transportOptions);
  const fetch: CodexResponsesFetch = (request) =>
    transport.send({
      body: request.body,
      operation: request.operation ?? (request.url.endsWith('/compact') ? 'compact' : 'generate'),
      wireProtocol:
        request.headers['x-openai-internal-codex-responses-lite'] === 'true'
          ? 'responses-lite'
          : 'classic',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

  return Object.freeze({
    configuration: Object.freeze({
      extensionId,
      providerId: CODEX_COMPANION_PROVIDER_ID,
    }),
    auth: createExtensionAuthProvider(authOptions),
    authPlugin: createExtensionAuthPlugin(authOptions),
    transport,
    fetch,
    requestOriginAccess,
    async ensureOriginAccess() {
      if (!(await requestOriginAccess()).approved) {
        throw new CodexCompanionError(
          'ORIGIN_APPROVAL_REQUIRED',
          'Approve this exact website origin in the Loom.js Companion options, then retry.',
        );
      }
    },
  });
}
