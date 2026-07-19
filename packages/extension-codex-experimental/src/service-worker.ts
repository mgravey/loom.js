import { createCodexExperimentalExtension } from './composition.js';
import type { CodexChromeExtensionApi, CodexModelFetch, OAuthFetch } from './chrome-contracts.js';
import { externallyConnectableOrigins } from './manifest-origins.js';
import { isCodexDirectAuthRequest } from './direct-auth.js';
import { isCodexOriginAccessRequest } from './origin-access.js';

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi;
  readonly fetch: OAuthFetch & CodexModelFetch;
};
const fetchRequest = host.fetch.bind(globalThis);
if (host.chrome.runtime.getManifest === undefined) {
  throw new Error('Chrome runtime manifest access is unavailable.');
}
const allowedOrigins = externallyConnectableOrigins(host.chrome.runtime.getManifest());
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
  modelFetchRequest: fetchRequest,
  allowedOrigins,
});

host.chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  globalThis.console.info(
    '[loom:extension-auth]',
    Object.freeze({ event: 'message.received', ...authEnvelopeMetadata(message) }),
  );
  const listener = isCodexOriginAccessRequest(message)
    ? composition.originAccessExternalMessageListener
    : isCodexDirectAuthRequest(message)
      ? composition.directAuthExternalMessageListener
      : composition.externalMessageListener;
  return listener(message, sender, (response) => {
    globalThis.console.info(
      '[loom:extension-auth]',
      Object.freeze({ event: 'message.response', ...authEnvelopeMetadata(response) }),
    );
    sendResponse(response);
  });
});

host.chrome.runtime.onConnectExternal.addListener(composition.modelPortListener);
