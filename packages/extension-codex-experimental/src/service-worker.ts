import { createCodexExperimentalExtension } from './composition.js';
import type { CodexChromeExtensionApi, CodexModelFetch, OAuthFetch } from './chrome-contracts.js';
import { externallyConnectableOrigins } from './manifest-origins.js';
import { createCodexModelPortListener, type CodexModelDiagnosticEvent } from './model-transport.js';
import { createOriginAuthorizer } from '@loom/extension';

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly fetch: OAuthFetch & CodexModelFetch;
};
const fetchRequest = host.fetch.bind(globalThis);
if (host.chrome.runtime.getManifest === undefined) {
  throw new Error('Chrome runtime manifest access is unavailable.');
}
const allowedOrigins = externallyConnectableOrigins(host.chrome.runtime.getManifest());
const originAuthorizer = createOriginAuthorizer(allowedOrigins);
const reportModelDiagnostic = (event: CodexModelDiagnosticEvent): void => {
  globalThis.console.info('[loom:extension-model]', event);
};
const authEnvelopeMetadata = (value: unknown): Readonly<Record<string, string | boolean>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const envelope = value as Readonly<Record<string, unknown>>;
  const error =
    typeof envelope.error === 'object' && envelope.error !== null && !Array.isArray(envelope.error)
      ? (envelope.error as Readonly<Record<string, unknown>>)
      : undefined;
  return Object.freeze({
    ...(typeof envelope.type === 'string' ? { type: envelope.type } : {}),
    ...(typeof envelope.requestId === 'string' ? { requestId: envelope.requestId } : {}),
    ...(typeof envelope.ok === 'boolean' ? { ok: envelope.ok } : {}),
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
  });
};
const composition = createCodexExperimentalExtension({
  chromeApi: host.chrome,
  fetchRequest,
  allowedOrigins,
});

host.chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  globalThis.console.info(
    '[loom:extension-auth]',
    Object.freeze({ event: 'message.received', ...authEnvelopeMetadata(message) }),
  );
  return composition.externalMessageListener(message, sender, (response) => {
    globalThis.console.info(
      '[loom:extension-auth]',
      Object.freeze({ event: 'message.response', ...authEnvelopeMetadata(response) }),
    );
    sendResponse(response);
  });
});
host.chrome.runtime.onConnectExternal.addListener(
  createCodexModelPortListener({
    providerId: composition.providerId,
    tokenService: composition.tokenService,
    accountRoutingStore: composition.accountRoutingStore,
    fetchRequest,
    authorizer: originAuthorizer,
    diagnosticSink: reportModelDiagnostic,
  }),
);
