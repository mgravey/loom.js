import { validCallbackPath } from './constants.js';
import { isLoopbackRedirectOrigin } from './environment.js';
import { chatgptError, type ChatGPTBrowserError } from './errors.js';
import { record } from './http.js';

/** What the broker hands to the client after one authorization attempt. */
export type ChatGPTBrowserRedirectResult =
  /** The broker captured the loopback callback; `url` is the full callback URL. */
  | { readonly status: 'callback'; readonly url: string }
  /** The user closed the sign-in window, the attempt expired, or it was cancelled. */
  | { readonly status: 'cancelled' }
  /** The broker is not available to this page (for example missing, disabled, or not approved). */
  | { readonly status: 'unavailable' }
  /** The broker could not complete the attempt. */
  | { readonly status: 'failed' };

export interface ChatGPTBrowserRedirectRequest {
  /** The complete OpenAI authorization URL, including `redirect_uri` and `state`. */
  readonly authorizationUrl: string;
  /** The attempt's OAuth `state`; the broker must only return a callback carrying it. */
  readonly state: string;
  /** Aborted when the client cancels, times out, or is disposed. */
  readonly signal: AbortSignal;
}

/**
 * Optional sign-in helper for pages that are not served from `http://127.0.0.1:<port>`.
 *
 * The broker owns the sign-in window and captures the browser's navigation to the registered
 * loopback `redirectUri` without anything listening on it, then hands the callback back to this
 * client only. The client still generates state, nonce, and PKCE, exchanges the code, verifies the
 * ID token, and holds every token in memory. A browser extension is the expected implementation.
 */
export interface ChatGPTBrowserRedirectBroker {
  /** The registered loopback redirect, exactly `http://127.0.0.1:<port><path>`. */
  readonly redirectUri: string;
  /**
   * Opens `authorizationUrl` in a broker-owned window. Called outside a user gesture. Must resolve
   * once (never with a callback for another `state`) and stop when `signal` aborts.
   */
  authorize(request: ChatGPTBrowserRedirectRequest): Promise<ChatGPTBrowserRedirectResult>;
}

/** Validates the broker contract once, at client construction. */
export function validateRedirectBroker(value: unknown): ChatGPTBrowserRedirectBroker | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    typeof value.authorize !== 'function' ||
    typeof value.redirectUri !== 'string'
  )
    throw new TypeError('Invalid ChatGPT redirect broker.');
  let url: URL;
  try {
    url = new URL(value.redirectUri);
  } catch {
    throw new TypeError('Invalid ChatGPT redirect broker URI.');
  }
  if (
    !isLoopbackRedirectOrigin(url) ||
    url.port === '' ||
    value.redirectUri !== `${url.origin}${url.pathname}` ||
    !validCallbackPath(url.pathname)
  )
    throw new TypeError(
      'ChatGPT redirect broker URI must be http://127.0.0.1:<port>/<path> without query or fragment.',
    );
  return value as unknown as ChatGPTBrowserRedirectBroker;
}

/**
 * Runs one brokered authorization and returns the callback URL. Every failure becomes a sanitized
 * `ChatGPTBrowserError`; nothing from the broker is attached to it.
 */
export async function brokerCallback(
  broker: ChatGPTBrowserRedirectBroker,
  request: ChatGPTBrowserRedirectRequest,
): Promise<URL> {
  let result: unknown;
  try {
    result = await broker.authorize(request);
  } catch {
    throw chatgptError('sign-in-failed', 'The ChatGPT sign-in helper failed. Try again.');
  }
  if (request.signal.aborted)
    throw chatgptError('sign-in-cancelled', 'ChatGPT sign-in was cancelled or expired.');
  const status = record(result) ? result.status : undefined;
  if (status === 'callback' && record(result) && typeof result.url === 'string') {
    try {
      if (result.url.length <= 16_384) return new URL(result.url);
    } catch {
      /* Fall through to the sanitized failure below. */
    }
  }
  throw brokerFailure(status);
}

function brokerFailure(status: unknown): ChatGPTBrowserError {
  if (status === 'cancelled')
    return chatgptError(
      'sign-in-cancelled',
      'ChatGPT sign-in window was closed or expired. Start a fresh sign-in when ready.',
    );
  if (status === 'unavailable')
    return chatgptError(
      'unsupported-environment',
      'The ChatGPT sign-in helper is unavailable for this page. Check that it is installed, enabled, and that this website is approved.',
    );
  return chatgptError('sign-in-failed', 'ChatGPT sign-in could not be completed. Try again.');
}
