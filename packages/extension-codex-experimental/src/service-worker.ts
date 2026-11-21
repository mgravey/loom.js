import type { ResponsesModelsFetch } from './responses-models.js';
import { createCodexExperimentalExtension } from './composition.js';
import type { CodexChromeExtensionApi, CodexModelFetch, OAuthFetch } from './chrome-contracts.js';
import { createExternallyConnectableAuthorizer } from './manifest-origins.js';
import { isCodexDirectAuthRequest } from './direct-auth.js';
import { isResponsesConnectionRequest } from './responses-connections.js';
import { createGrantedOriginAuthorizer, isCodexOriginAccessRequest } from './origin-access.js';
import {
  createChatGPTHelper,
  isChatGPTHelperRequest,
  type ChatGPTHelper,
  type ChatGPTHelperChromeApi,
  type ChatGPTHelperFetch,
} from './chatgpt-helper.js';

type ChatGPTHelperCallbackListener = ChatGPTHelper['callbackMessageListener'];

const host = globalThis as unknown as {
  readonly chrome: CodexChromeExtensionApi &
    ChatGPTHelperChromeApi & {
      readonly runtime: {
        readonly onMessage: { addListener(listener: ChatGPTHelperCallbackListener): void };
      };
    };
  readonly fetch: OAuthFetch & CodexModelFetch & ResponsesModelsFetch & ChatGPTHelperFetch;
};
const fetchRequest = host.fetch.bind(globalThis);
if (host.chrome.runtime.getManifest === undefined) {
  throw new Error('Chrome runtime manifest access is unavailable.');
}
const manifestAuthorizer = createExternallyConnectableAuthorizer(host.chrome.runtime.getManifest());
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
  modelsFetchRequest: fetchRequest,
  manifestAuthorizer,
});

// Generic ChatGPT sign-in helper for approved websites. It shares the exact-origin approvals.
const chatgptHelper = createChatGPTHelper({
  chromeApi: host.chrome,
  fetch: fetchRequest,
  manifestAuthorizer,
  authorizer: createGrantedOriginAuthorizer(manifestAuthorizer, composition.originAccessStore),
});
void chatgptHelper.removeStaleRules();
host.chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  chatgptHelper.callbackMessageListener(message, sender, sendResponse),
);

host.chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  globalThis.console.info(
    '[loom:extension-auth]',
    Object.freeze({ event: 'message.received', ...authEnvelopeMetadata(message) }),
  );
  const listener = isChatGPTHelperRequest(message)
    ? chatgptHelper.externalMessageListener
    : isResponsesConnectionRequest(message)
      ? composition.responsesConnectionListener
      : isCodexOriginAccessRequest(message)
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
host.chrome.runtime.onConnectExternal.addListener((port) => chatgptHelper.portListener(port));
