import type { ChromeStorageArea } from '@mgravey/loom-extension';

import { CHATGPT_HELPER_ENABLED_KEY, CHATGPT_HELPER_HOST_PERMISSIONS } from './chatgpt-helper.js';

export interface ChatGPTHelperOptionsChromeApi {
  readonly storage: { readonly local: ChromeStorageArea };
  readonly permissions?: {
    contains(details: { origins: string[] }): Promise<boolean>;
    request(details: { origins: string[] }): Promise<boolean>;
  };
}

export type ChatGPTHelperOptionsState = 'on' | 'off' | 'permission-missing';

/** Reads the opt-in flag and whether Chrome still grants the helper's optional host access. */
export async function readChatGPTHelperState(
  chromeApi: ChatGPTHelperOptionsChromeApi,
): Promise<ChatGPTHelperOptionsState> {
  const values = await chromeApi.storage.local.get(CHATGPT_HELPER_ENABLED_KEY);
  if (values[CHATGPT_HELPER_ENABLED_KEY] !== true) return 'off';
  const granted = await chromeApi.permissions?.contains({
    origins: [...CHATGPT_HELPER_HOST_PERMISSIONS],
  });
  return granted === true ? 'on' : 'permission-missing';
}

/**
 * Turns the helper on (requesting the optional host permissions in the same user gesture) or off.
 * Turning it off keeps Chrome's grants because a saved custom server may rely on the same origins.
 */
export async function setChatGPTHelperEnabled(
  chromeApi: ChatGPTHelperOptionsChromeApi,
  enabled: boolean,
): Promise<ChatGPTHelperOptionsState> {
  if (!enabled) {
    await chromeApi.storage.local.set({ [CHATGPT_HELPER_ENABLED_KEY]: false });
    return 'off';
  }
  // Must be the first await so Chrome still sees the click's user activation.
  const granted = await chromeApi.permissions?.request({
    origins: [...CHATGPT_HELPER_HOST_PERMISSIONS],
  });
  if (granted !== true) return 'permission-missing';
  await chromeApi.storage.local.set({ [CHATGPT_HELPER_ENABLED_KEY]: true });
  return 'on';
}

const MESSAGES: Readonly<Record<ChatGPTHelperOptionsState, string>> = Object.freeze({
  on: 'The helper is on for approved websites.',
  off: 'The helper is off.',
  'permission-missing':
    'The helper needs access to api.openai.com and 127.0.0.1. Enable it again and allow access.',
});

export function initializeChatGPTHelperOptions(
  document: Document,
  chromeApi: ChatGPTHelperOptionsChromeApi,
): void {
  const toggle = document.querySelector('#chatgpt-helper-enabled');
  const status = document.querySelector('#chatgpt-helper-status');
  if (!(toggle instanceof HTMLInputElement) || !(status instanceof HTMLElement)) return;
  const render = (state: ChatGPTHelperOptionsState): void => {
    toggle.checked = state === 'on';
    status.textContent = MESSAGES[state];
  };
  const fail = (): void => {
    status.textContent = 'The helper setting could not be updated.';
  };
  toggle.addEventListener('change', () => {
    toggle.disabled = true;
    void setChatGPTHelperEnabled(chromeApi, toggle.checked)
      .then(render, fail)
      .finally(() => {
        toggle.disabled = false;
      });
  });
  void readChatGPTHelperState(chromeApi).then(render, fail);
}
