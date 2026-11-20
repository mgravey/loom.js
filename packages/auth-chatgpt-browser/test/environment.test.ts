import { describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE,
  completeChatGPTBrowserCallback,
  detectChatGPTBrowserSupport,
  type ChatGPTBrowserCallbackWindow,
} from '../src/index.js';

const ORIGIN = 'http://127.0.0.1:5173';

function callbackWindow(
  href = `${ORIGIN}/auth/callback?code=code-secret&state=state-value`,
  opener: unknown = undefined,
) {
  const replaceState = vi.fn();
  const postMessage = vi.fn();
  const target: ChatGPTBrowserCallbackWindow = {
    location: { href },
    history: { replaceState },
    opener: opener === undefined ? { location: { origin: ORIGIN }, postMessage } : opener,
  };
  return { target, replaceState, postMessage };
}

describe('completeChatGPTBrowserCallback', () => {
  it('strips the code from history and posts the URL only to the same-origin opener', () => {
    const { target, replaceState, postMessage } = callbackWindow();
    expect(completeChatGPTBrowserCallback({ window: target })).toEqual({ delivered: true });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth/callback');
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      postMessage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE, url: target.location.href },
      ORIGIN,
    );
  });

  it('supports a custom path and message type', () => {
    const { target, postMessage } = callbackWindow(`${ORIGIN}/oauth/chatgpt?code=c&state=s`);
    expect(
      completeChatGPTBrowserCallback({
        window: target,
        callbackPath: '/oauth/chatgpt',
        messageType: 'host/chatgpt',
      }),
    ).toEqual({ delivered: true });
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'host/chatgpt' });
  });

  it.each([
    ['unsupported-environment', `https://example.test/auth/callback?code=c`, undefined],
    ['unsupported-environment', `http://localhost:5173/auth/callback?code=c`, undefined],
    ['unexpected-path', `${ORIGIN}/callback?code=c`, undefined],
    ['unexpected-path', 'not a url', undefined],
    ['no-opener', `${ORIGIN}/auth/callback?code=c`, null],
    [
      'opener-origin-mismatch',
      `${ORIGIN}/auth/callback?code=c`,
      { location: { origin: 'http://127.0.0.1:9999' }, postMessage: vi.fn() },
    ],
    [
      'opener-origin-mismatch',
      `${ORIGIN}/auth/callback?code=c`,
      {
        get location(): never {
          throw new Error('cross-origin');
        },
        postMessage: vi.fn(),
      },
    ],
    [
      'delivery-failed',
      `${ORIGIN}/auth/callback?code=c`,
      {
        location: { origin: ORIGIN },
        postMessage: () => {
          throw new Error('closed');
        },
      },
    ],
  ] as const)('reports %s for %s', (reason, href, opener) => {
    const { target, replaceState } = callbackWindow(href, opener);
    expect(completeChatGPTBrowserCallback({ window: target })).toEqual({
      delivered: false,
      reason,
    });
    if (href !== 'not a url') expect(replaceState).toHaveBeenCalledOnce();
  });

  it('survives a failing history API and rejects invalid configuration', () => {
    const { target, postMessage } = callbackWindow();
    target.history.replaceState = () => {
      throw new Error('history');
    };
    expect(completeChatGPTBrowserCallback({ window: target })).toEqual({ delivered: true });
    expect(postMessage).toHaveBeenCalledOnce();
    expect(() => completeChatGPTBrowserCallback({ window: target, callbackPath: 'x' })).toThrow(
      TypeError,
    );
    expect(() => completeChatGPTBrowserCallback({ window: target, messageType: ' ' })).toThrow(
      TypeError,
    );
  });

  it('reports a missing window', () => {
    expect(completeChatGPTBrowserCallback()).toEqual({
      delivered: false,
      reason: 'unsupported-environment',
    });
  });
});

describe('detectChatGPTBrowserSupport', () => {
  const crypto = globalThis.crypto;
  it.each([
    [{}, { supported: false, reason: 'no-window' }],
    [
      { window: { location: new URL(`${ORIGIN}/`) } },
      { supported: false, reason: 'web-crypto-unavailable' },
    ],
    [
      { window: { location: new URL('https://example.test/') }, crypto },
      { supported: false, reason: 'origin-not-loopback' },
    ],
    [
      { window: { location: new URL('http://localhost:5173/') }, crypto },
      { supported: false, reason: 'origin-not-loopback' },
    ],
    [{ window: { location: new URL(`${ORIGIN}/app`) }, crypto }, { supported: true }],
  ] as const)('detects %j', (environment, expected) => {
    expect(detectChatGPTBrowserSupport(environment)).toEqual(expected);
  });
});
