import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_HELPER_ENABLED_KEY,
  CHATGPT_HELPER_HOST_PERMISSIONS,
} from '../src/chatgpt-helper.js';
import {
  initializeChatGPTHelperOptions,
  readChatGPTHelperState,
  setChatGPTHelperEnabled,
} from '../src/chatgpt-helper-options.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function chromeApi(granted: boolean, requestResult = true) {
  const values = new Map<string, unknown>();
  return {
    values,
    api: {
      storage: {
        local: {
          setAccessLevel: vi.fn(() => Promise.resolve()),
          get: vi.fn((key: string) =>
            Promise.resolve(values.has(key) ? { [key]: values.get(key) } : {}),
          ),
          set: vi.fn((items: Record<string, unknown>) => {
            Object.entries(items).forEach(([key, value]) => values.set(key, value));
            return Promise.resolve();
          }),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
      permissions: {
        contains: vi.fn(() => Promise.resolve(granted)),
        request: vi.fn(() => Promise.resolve(requestResult)),
      },
    },
  };
}

describe('ChatGPT helper options', () => {
  it('requests the optional host permissions before turning the helper on', async () => {
    const { api, values } = chromeApi(true);
    expect(await readChatGPTHelperState(api)).toBe('off');
    expect(await setChatGPTHelperEnabled(api, true)).toBe('on');
    expect(api.permissions.request).toHaveBeenCalledWith({
      origins: [...CHATGPT_HELPER_HOST_PERMISSIONS],
    });
    expect(values.get(CHATGPT_HELPER_ENABLED_KEY)).toBe(true);
    expect(await readChatGPTHelperState(api)).toBe('on');
    expect(await setChatGPTHelperEnabled(api, false)).toBe('off');
    expect(values.get(CHATGPT_HELPER_ENABLED_KEY)).toBe(false);
  });

  it('stays off when Chrome access is declined or later removed', async () => {
    const declined = chromeApi(false, false);
    expect(await setChatGPTHelperEnabled(declined.api, true)).toBe('permission-missing');
    expect(declined.values.has(CHATGPT_HELPER_ENABLED_KEY)).toBe(false);
    declined.values.set(CHATGPT_HELPER_ENABLED_KEY, true);
    expect(await readChatGPTHelperState(declined.api)).toBe('permission-missing');
  });

  it('wires the toggle and status text', async () => {
    class FakeElement {
      public textContent = '';
    }
    class FakeInput extends FakeElement {
      public checked = false;
      public disabled = false;
      public listener: (() => void) | undefined;
      public addEventListener(_type: string, listener: () => void) {
        this.listener = listener;
      }
    }
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    const toggle = new FakeInput();
    const status = new FakeElement();
    const document = {
      querySelector: (selector: string) =>
        selector === '#chatgpt-helper-enabled' ? toggle : status,
    } as unknown as Document;
    const { api } = chromeApi(true);
    initializeChatGPTHelperOptions(document, api);
    await vi.waitFor(() => expect(status.textContent).toBe('The helper is off.'));
    toggle.checked = true;
    toggle.listener?.();
    await vi.waitFor(() => expect(status.textContent).toContain('on for approved websites'));
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    initializeChatGPTHelperOptions({ querySelector: () => null } as unknown as Document, api);
  });
});
