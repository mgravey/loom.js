import {
  ChatGPTBrowserError,
  createChatGPTBrowserClient,
  type ChatGPTBrowserClient,
  type ChatGPTBrowserStatus,
} from '@mgravey/loom-auth-chatgpt-browser';

import { CHATGPT_CALLBACK_MESSAGE_TYPE, CHATGPT_LOCAL_URL } from './chatgpt-config.js';

/** Workbench configuration for the public browser-only Sign in with ChatGPT client. */
const PROTOTYPE = 'Local browser sign-in is experimental.';

export { ChatGPTBrowserError as ChatGPTDirectError };
export type ChatGPTDirectClient = ChatGPTBrowserClient;
export type ChatGPTDirectStatus = ChatGPTBrowserStatus;

export function createChatGPTDirectClient(): ChatGPTDirectClient {
  return createChatGPTBrowserClient({
    appName: 'Loom.js',
    messageType: CHATGPT_CALLBACK_MESSAGE_TYPE,
    // Keep the keys used by earlier workbench builds so saved registrations remain available.
    storageKeyPrefix: 'loom.chatgpt-direct.',
    toolNamespace: { description: 'Tools provided by the Loom.js browser workbench.' },
    notices: {
      ready: PROTOTYPE,
      unsupported: (reason) =>
        reason === 'origin-not-loopback'
          ? `Local test only. Open ${CHATGPT_LOCAL_URL}. This prototype requires HTTP 127.0.0.1; public/static hosting does not enable browser OAuth support.`
          : `ChatGPT sign-in is unavailable in this browser (${reason}).`,
    },
  });
}
