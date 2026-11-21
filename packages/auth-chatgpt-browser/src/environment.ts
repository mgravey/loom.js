import {
  CHATGPT_BROWSER_DEFAULT_CALLBACK_PATH,
  CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE,
  validCallbackPath,
  validMessageType,
} from './constants.js';

/**
 * Why the documented flow cannot run on this page. OpenAI's open-source registration accepts only
 * an HTTP loopback redirect on `127.0.0.1` (not `localhost`, not HTTPS, not a public origin).
 */
export type ChatGPTBrowserUnsupportedReason =
  /** No browser window (for example a worker or server runtime). */
  | 'no-window'
  /** Web Crypto (`crypto.subtle`, `crypto.getRandomValues`) is unavailable. */
  | 'web-crypto-unavailable'
  /** The page is not served from `http://127.0.0.1:<port>`. */
  | 'origin-not-loopback'
  /** The client was disposed. */
  | 'disposed';

/**
 * How a supported page signs in. Reported only when a redirect broker was considered:
 * `redirect-broker` means a helper (for example the Loom.js Companion extension) captures the
 * loopback callback, so the page origin itself need not be `127.0.0.1`.
 */
export type ChatGPTBrowserSupportMode = 'redirect-broker';

export interface ChatGPTBrowserSupport {
  readonly supported: boolean;
  readonly reason?: ChatGPTBrowserUnsupportedReason;
  readonly mode?: ChatGPTBrowserSupportMode;
}

export interface DetectChatGPTBrowserSupportOptions {
  /** True when a validated redirect broker is available; lifts the loopback-origin requirement. */
  readonly redirectBroker?: boolean;
}

export interface ChatGPTBrowserLocationLike {
  readonly protocol: string;
  readonly hostname: string;
}

/** True only for the documented loopback redirect origin, `http://127.0.0.1:<port>`. */
export function isLoopbackRedirectOrigin(location: ChatGPTBrowserLocationLike): boolean {
  return location.protocol === 'http:' && location.hostname === '127.0.0.1';
}

/**
 * Reports whether the current page can run browser-only Sign in with ChatGPT, and why not. With
 * `{ redirectBroker: true }` any origin is supported and the result carries
 * `mode: 'redirect-broker'`; without it the result is unchanged (loopback origins only).
 */
export function detectChatGPTBrowserSupport(
  environment: {
    readonly window?: { readonly location?: ChatGPTBrowserLocationLike };
    readonly crypto?: Partial<Pick<Crypto, 'subtle' | 'getRandomValues'>>;
  } = globalThis,
  options: DetectChatGPTBrowserSupportOptions = {},
): ChatGPTBrowserSupport {
  const location = environment.window?.location;
  if (location === undefined) return Object.freeze({ supported: false, reason: 'no-window' });
  if (
    typeof environment.crypto?.subtle?.digest !== 'function' ||
    typeof environment.crypto.getRandomValues !== 'function'
  )
    return Object.freeze({ supported: false, reason: 'web-crypto-unavailable' });
  if (options.redirectBroker === true)
    return Object.freeze({ supported: true, mode: 'redirect-broker' });
  if (!isLoopbackRedirectOrigin(location))
    return Object.freeze({ supported: false, reason: 'origin-not-loopback' });
  return Object.freeze({ supported: true });
}

export interface ChatGPTBrowserCallbackWindow {
  readonly location: { readonly href: string };
  readonly history: { replaceState(data: unknown, unused: string, url?: string): void };
  readonly opener: unknown;
}

export interface CompleteChatGPTBrowserCallbackOptions {
  /** Must match the client's `messageType`. */
  readonly messageType?: string;
  /** Must match the client's `callbackPath`. Defaults to `/auth/callback`. */
  readonly callbackPath?: string;
  /** Defaults to the global `window`; injectable for tests and embedded hosts. */
  readonly window?: ChatGPTBrowserCallbackWindow;
}

export type ChatGPTBrowserCallbackFailure =
  | 'unsupported-environment'
  | 'unexpected-path'
  | 'no-opener'
  | 'opener-origin-mismatch'
  | 'delivery-failed';

export type ChatGPTBrowserCallbackResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: ChatGPTBrowserCallbackFailure };

interface OpenerLike {
  readonly location: { readonly origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Runs on the callback page or route. Removes the one-time code from the current history entry,
 * checks the loopback origin, path, and same-origin opener, then posts the callback URL only to
 * the opener's exact origin. The opener validates state, exchanges the code, and closes the popup.
 * It never exchanges codes, stores values, or logs URLs.
 */
export function completeChatGPTBrowserCallback(
  options: CompleteChatGPTBrowserCallbackOptions = {},
): ChatGPTBrowserCallbackResult {
  const fail = (reason: ChatGPTBrowserCallbackFailure): ChatGPTBrowserCallbackResult =>
    Object.freeze({ delivered: false, reason });
  const callbackPath = options.callbackPath ?? CHATGPT_BROWSER_DEFAULT_CALLBACK_PATH;
  const messageType = options.messageType ?? CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE;
  if (!validCallbackPath(callbackPath) || !validMessageType(messageType))
    throw new TypeError('Invalid ChatGPT callback path or message type.');
  const target =
    options.window ??
    (globalThis as { readonly window?: ChatGPTBrowserCallbackWindow }).window ??
    undefined;
  if (target === undefined) return fail('unsupported-environment');
  const href = target.location.href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return fail('unexpected-path');
  }
  try {
    // Remove the short-lived code from this history entry before doing anything else.
    target.history.replaceState(null, '', url.pathname);
  } catch {
    /* A failed history update does not expose the code to any other party. */
  }
  if (!isLoopbackRedirectOrigin(url)) return fail('unsupported-environment');
  if (url.pathname !== callbackPath) return fail('unexpected-path');
  const opener = target.opener as OpenerLike | null | undefined;
  if (opener === null || opener === undefined) return fail('no-opener');
  let openerOrigin: string;
  try {
    openerOrigin = opener.location.origin;
  } catch {
    return fail('opener-origin-mismatch');
  }
  if (openerOrigin !== url.origin) return fail('opener-origin-mismatch');
  try {
    opener.postMessage({ type: messageType, url: href }, openerOrigin);
  } catch {
    return fail('delivery-failed');
  }
  return Object.freeze({ delivered: true });
}
