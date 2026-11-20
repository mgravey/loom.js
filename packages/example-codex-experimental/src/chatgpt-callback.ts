import { completeChatGPTBrowserCallback } from '@mgravey/loom-auth-chatgpt-browser';

import { CHATGPT_CALLBACK_MESSAGE_TYPE, CHATGPT_LOCAL_URL } from './chatgpt-config.js';

const status = globalThis.document.getElementById('status');
const result = completeChatGPTBrowserCallback({ messageType: CHATGPT_CALLBACK_MESSAGE_TYPE });
if (status !== null)
  status.textContent = result.delivered
    ? 'Returned to Loom.js. You can close this window.'
    : `The local workbench is unavailable. Close this window and start a fresh sign-in from ${CHATGPT_LOCAL_URL}`;
