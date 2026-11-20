import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatGPTBrowserError } from '@mgravey/loom-auth-chatgpt-browser';

import { ChatGPTDirectError, createChatGPTDirectClient } from '../src/chatgpt-direct.js';
import { CHATGPT_CALLBACK_MESSAGE_TYPE, CHATGPT_LOCAL_URL } from '../src/chatgpt-config.js';

afterEach(() => vi.unstubAllGlobals());

function stubWindow(origin: string) {
  const storage = new Map<string, string>();
  const popup = { closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const listeners = new Set<(event: MessageEvent) => void>();
  vi.stubGlobal('window', {
    location: new URL(`${origin}/example-codex-experimental/workbench.html`),
    open: vi.fn(() => popup),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  });
  return { storage, popup, listeners };
}

describe('workbench ChatGPT client configuration', () => {
  it('keeps the workbench app name, storage keys, and local-only instructions', async () => {
    const { storage, popup } = stubWindow('http://127.0.0.1:4174');
    storage.set(
      'loom.chatgpt-direct.registrations.v1',
      JSON.stringify([{ id: 'oaiapp_saved', label: 'Saved (oaiapp_saved)', subject: 's' }]),
    );
    const client = createChatGPTDirectClient();
    expect(client.getStatus()).toMatchObject({
      supported: true,
      notice: 'Local browser sign-in is experimental.',
      accounts: [{ id: 'oaiapp_saved', label: 'Saved (oaiapp_saved)', verified: true }],
    });
    const pending = client.signIn();
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce());
    const url = new URL(popup.location.replace.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('agent_name_hint')).toBe('Loom.js');
    expect(storage.has('loom.chatgpt-direct.host.v1')).toBe(true);
    client.dispose();
    await expect(pending).rejects.toThrow('cancelled');
    expect(ChatGPTDirectError).toBe(ChatGPTBrowserError);
    expect(CHATGPT_CALLBACK_MESSAGE_TYPE).toBe('loom/chatgpt-direct/callback');
  });

  it('explains the local URL on unsupported origins', async () => {
    stubWindow('https://mgravey.com');
    const client = createChatGPTDirectClient();
    expect(client.getStatus().notice).toContain(CHATGPT_LOCAL_URL);
    await expect(client.signIn()).rejects.toThrow('127.0.0.1');
    client.dispose();
  });
});
