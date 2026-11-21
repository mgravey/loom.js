import type {
  CodexCompanionPort,
  CodexCompanionRuntime,
  CodexCompanionRuntimeSource,
  CodexCompanionValueSource,
} from './contracts.js';
import {
  LOOM_COMPANION_EXTENSION_ID,
  isRecord,
  resolveIdentifier,
  resolveRuntime,
} from './shared.js';

/**
 * Page side of the Companion's generic "Sign in with ChatGPT" helper.
 *
 * The objects returned here plug into `createChatGPTBrowserClient` from
 * `@mgravey/loom-auth-chatgpt-browser` (`redirectBroker` and `fetch`). They are structurally typed
 * so this package does not depend on it. The website keeps running the OAuth flow and holding the
 * tokens; the extension only captures the loopback callback and relays four fixed OpenAI requests.
 */
export const CHATGPT_HELPER_PROTOCOL = 'loom/chatgpt-helper' as const;
export const CHATGPT_HELPER_VERSION = 1 as const;
export const CHATGPT_HELPER_PORT_NAME = 'loom/chatgpt-helper/v1' as const;

/** Requests relayed through the extension. Everything else uses the fallback fetch. */
export const CHATGPT_HELPER_RELAYED_REQUESTS = Object.freeze({
  'openid-configuration': Object.freeze({
    method: 'GET',
    url: 'https://auth.openai.com/.well-known/openid-configuration',
  }),
  jwks: Object.freeze({ method: 'GET', url: 'https://auth.openai.com/.well-known/jwks.json' }),
  models: Object.freeze({ method: 'GET', url: 'https://api.openai.com/v1/models' }),
  responses: Object.freeze({ method: 'POST', url: 'https://api.openai.com/v1/responses' }),
} as const);

type RelayTarget = keyof typeof CHATGPT_HELPER_RELAYED_REQUESTS;
const RELAY_TARGETS: readonly RelayTarget[] = [
  'openid-configuration',
  'jwks',
  'models',
  'responses',
];

const KEEPALIVE_MS = 20_000;
const STATUS_TIMEOUT_MS = 5_000;
const REDIRECT_URI = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[A-Za-z0-9._~/-]{1,200}$/u;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export type CompanionChatGPTHelperUnavailableReason =
  /** No Chrome runtime on this page, or the Companion is not installed or not reachable. */
  | 'extension-unavailable'
  /** The Companion is installed but this exact origin is not approved (approval may be pending). */
  | 'origin-not-approved'
  /** This origin is approved but the user has not enabled the helper in the Companion options. */
  | 'helper-disabled'
  /** The installed Companion does not implement this helper version. */
  | 'unsupported-version';

export type CompanionChatGPTHelperStatus =
  | { readonly available: true; readonly redirectUri: string }
  | { readonly available: false; readonly reason: CompanionChatGPTHelperUnavailableReason };

export interface CompanionChatGPTHelperOptions {
  /** Defaults to the published Loom.js Companion Store ID. */
  readonly extensionId?: CodexCompanionValueSource;
  readonly runtime: CodexCompanionRuntimeSource;
  /** Used for every request the extension does not relay. Defaults to the global `fetch`. */
  readonly fallbackFetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface CreateCompanionChatGPTHelperOptions extends CompanionChatGPTHelperOptions {
  /** The `redirectUri` reported by `getCompanionChatGPTHelperStatus`. */
  readonly redirectUri: string;
}

/** Structurally compatible with `ChatGPTBrowserRedirectResult`. */
export type CompanionChatGPTRedirectResult =
  | { readonly status: 'callback'; readonly url: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' };

/** Structurally compatible with `ChatGPTBrowserRedirectBroker`. */
export interface CompanionChatGPTRedirectBroker {
  readonly redirectUri: string;
  authorize(request: {
    readonly authorizationUrl: string;
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<CompanionChatGPTRedirectResult>;
}

export type CompanionChatGPTFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CompanionChatGPTHelper {
  readonly redirectBroker: CompanionChatGPTRedirectBroker;
  readonly fetch: CompanionChatGPTFetch;
  /** Spread into `createChatGPTBrowserClient({ appName, ...helper.clientOptions })`. */
  readonly clientOptions: {
    readonly redirectBroker: CompanionChatGPTRedirectBroker;
    readonly fetch: CompanionChatGPTFetch;
  };
}

let nextRequest = 0;
function requestId(prefix: string): string {
  nextRequest += 1;
  return `${prefix}-${String(nextRequest)}`;
}

function extensionIdFrom(options: CompanionChatGPTHelperOptions): string {
  return resolveIdentifier(options.extensionId ?? LOOM_COMPANION_EXTENSION_ID, 'extension ID');
}

function sendMessage(
  runtime: CodexCompanionRuntime,
  extensionId: string,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), STATUS_TIMEOUT_MS);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    try {
      const returned = runtime.sendMessage(extensionId, message, undefined, (response) => {
        if (runtime.lastError !== undefined) finish(() => reject(new Error('unavailable')));
        else finish(() => resolve(response));
      });
      if (
        returned !== null &&
        (typeof returned === 'object' || typeof returned === 'function') &&
        typeof (returned as PromiseLike<unknown>).then === 'function'
      )
        void Promise.resolve(returned as PromiseLike<unknown>).then(
          (value) => finish(() => resolve(value)),
          () => finish(() => reject(new Error('unavailable'))),
        );
    } catch {
      finish(() => reject(new Error('unavailable')));
    }
  });
}

/**
 * Asks the Companion whether this page may use the helper. Never throws: a missing extension,
 * runtime, or reply is reported as `extension-unavailable`.
 */
export async function getCompanionChatGPTHelperStatus(
  options: CompanionChatGPTHelperOptions,
): Promise<CompanionChatGPTHelperStatus> {
  const unavailable = (
    reason: CompanionChatGPTHelperUnavailableReason,
  ): CompanionChatGPTHelperStatus => Object.freeze({ available: false, reason });
  let response: unknown;
  const id = requestId('loom-chatgpt-helper-status');
  try {
    response = await sendMessage(resolveRuntime(options.runtime), extensionIdFrom(options), {
      protocol: CHATGPT_HELPER_PROTOCOL,
      version: CHATGPT_HELPER_VERSION,
      type: 'getStatus',
      requestId: id,
    });
  } catch {
    return unavailable('extension-unavailable');
  }
  if (
    !isRecord(response) ||
    response.protocol !== CHATGPT_HELPER_PROTOCOL ||
    response.type !== 'status' ||
    response.requestId !== id
  )
    // Older Companion versions answer unknown protocols with their own envelopes.
    return unavailable(isRecord(response) ? 'unsupported-version' : 'extension-unavailable');
  if (response.version !== CHATGPT_HELPER_VERSION) return unavailable('unsupported-version');
  if (response.ok !== true) return unavailable('origin-not-approved');
  if (response.approved !== true) return unavailable('origin-not-approved');
  if (response.enabled !== true) return unavailable('helper-disabled');
  if (typeof response.redirectUri !== 'string' || !REDIRECT_URI.test(response.redirectUri))
    return unavailable('unsupported-version');
  return Object.freeze({ available: true, redirectUri: response.redirectUri });
}

interface OpenPort {
  readonly port: CodexCompanionPort;
  post(message: Readonly<Record<string, unknown>>): void;
  close(): void;
}

function openPort(
  options: CompanionChatGPTHelperOptions,
  onMessage: (message: Readonly<Record<string, unknown>>) => void,
  onDisconnect: () => void,
): OpenPort {
  const port = resolveRuntime(options.runtime).connect(extensionIdFrom(options), {
    name: CHATGPT_HELPER_PORT_NAME,
  });
  let closed = false;
  const post = (message: Readonly<Record<string, unknown>>): void => {
    if (closed) return;
    try {
      port.postMessage({
        protocol: CHATGPT_HELPER_PROTOCOL,
        version: CHATGPT_HELPER_VERSION,
        ...message,
      });
    } catch {
      close();
      onDisconnect();
    }
  };
  // Incoming port messages keep the extension's service worker alive during long waits.
  const keepalive = setInterval(() => post({ type: 'ping' }), KEEPALIVE_MS);
  const messageListener = (message: unknown): void => {
    if (
      !closed &&
      isRecord(message) &&
      message.protocol === CHATGPT_HELPER_PROTOCOL &&
      message.version === CHATGPT_HELPER_VERSION
    )
      onMessage(message);
  };
  const disconnectListener = (): void => {
    if (closed) return;
    close();
    onDisconnect();
  };
  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    port.onMessage.removeListener?.(messageListener);
    port.onDisconnect.removeListener?.(disconnectListener);
    try {
      port.disconnect();
    } catch {
      // Already closed by the extension.
    }
  }
  port.onMessage.addListener(messageListener);
  port.onDisconnect.addListener(disconnectListener);
  return { port, post, close };
}

function createRedirectBroker(
  options: CreateCompanionChatGPTHelperOptions,
): CompanionChatGPTRedirectBroker {
  const redirectUri = options.redirectUri;
  return Object.freeze({
    redirectUri,
    authorize(request: {
      readonly authorizationUrl: string;
      readonly state: string;
      readonly signal: AbortSignal;
    }): Promise<CompanionChatGPTRedirectResult> {
      return new Promise((resolve) => {
        const id = requestId('loom-chatgpt-helper-authorize');
        let done = false;
        let channel: OpenPort | undefined;
        const finish = (result: CompanionChatGPTRedirectResult): void => {
          if (done) return;
          done = true;
          request.signal.removeEventListener('abort', onAbort);
          channel?.close();
          resolve(Object.freeze(result));
        };
        const onAbort = (): void => {
          channel?.post({ type: 'cancel', requestId: id });
          finish({ status: 'cancelled' });
        };
        if (request.signal.aborted) {
          finish({ status: 'cancelled' });
          return;
        }
        request.signal.addEventListener('abort', onAbort, { once: true });
        try {
          channel = openPort(
            options,
            (message) => {
              if (message.requestId !== id) return;
              if (message.type === 'callback') {
                const url = message.url;
                finish(
                  typeof url === 'string' &&
                    url.startsWith(`${redirectUri}?`) &&
                    url.length <= 16_384
                    ? { status: 'callback', url }
                    : { status: 'failed' },
                );
              } else if (message.type === 'error') {
                const code = message.code;
                finish(
                  code === 'SIGN_IN_CANCELLED' || code === 'SIGN_IN_EXPIRED'
                    ? { status: 'cancelled' }
                    : code === 'UNAUTHORIZED_REQUEST' || code === 'HELPER_DISABLED'
                      ? { status: 'unavailable' }
                      : { status: 'failed' },
                );
              }
            },
            () => finish({ status: 'failed' }),
          );
        } catch {
          finish({ status: 'unavailable' });
          return;
        }
        channel.post({
          type: 'authorize',
          requestId: id,
          authorizationUrl: request.authorizationUrl,
          state: request.state,
        });
      });
    },
  });
}

function relayTarget(input: string, method: string): RelayTarget | undefined {
  return RELAY_TARGETS.find((target) => {
    const request = CHATGPT_HELPER_RELAYED_REQUESTS[target];
    return request.url === input && request.method === method;
  });
}

function authorizationHeader(headers: RequestInit['headers']): string | undefined {
  if (headers === undefined) return undefined;
  return new Headers(headers).get('authorization') ?? undefined;
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A `fetch` that relays the four allowlisted requests and streams the reply with backpressure. */
function createRelayFetch(options: CompanionChatGPTHelperOptions): CompanionChatGPTFetch {
  const fallback: CompanionChatGPTFetch =
    options.fallbackFetch ?? ((input, init) => globalThis.fetch(input, init));
  return (input, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const target = typeof input === 'string' ? relayTarget(input, method) : undefined;
    if (target === undefined) return fallback(input, init);
    const signal = init.signal ?? undefined;
    if (signal?.aborted === true) return Promise.reject(abortError());
    const authorization = authorizationHeader(init.headers);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string')
      return Promise.reject(new TypeError('The Companion relay accepts only string bodies.'));
    const body = typeof init.body === 'string' ? init.body : undefined;
    return new Promise<Response>((resolve, reject) => {
      const id = requestId('loom-chatgpt-helper-fetch');
      const encoder = new TextEncoder();
      const queue: Uint8Array[] = [];
      let expected = 0;
      let state: 'waiting' | 'streaming' | 'done' = 'waiting';
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let pulling: (() => void) | undefined;
      let ended = false;
      let channel: OpenPort | undefined;
      const stop = (error: Error): void => {
        if (state === 'done') return;
        const wasStreaming = state === 'streaming';
        state = 'done';
        signal?.removeEventListener('abort', onAbort);
        channel?.close();
        if (wasStreaming) {
          try {
            controller?.error(error);
          } catch {
            // The consumer already cancelled the stream.
          }
        } else reject(error);
      };
      const onAbort = (): void => {
        channel?.post({ type: 'cancel', requestId: id });
        stop(abortError());
      };
      const deliver = (): void => {
        if (controller === undefined) return;
        const chunk = queue.shift();
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          // Acknowledge only what the consumer pulled: this is the relay's backpressure.
          channel?.post({ type: 'ack', requestId: id });
          const wake = pulling;
          pulling = undefined;
          wake?.();
          return;
        }
        if (ended) {
          state = 'done';
          signal?.removeEventListener('abort', onAbort);
          channel?.close();
          controller.close();
          const wake = pulling;
          pulling = undefined;
          wake?.();
        }
      };
      const onMessage = (message: Readonly<Record<string, unknown>>): void => {
        if (message.requestId !== id || state === 'done') return;
        if (message.type === 'error') {
          stop(new TypeError('The Companion relay could not complete the request.'));
          return;
        }
        if (state === 'waiting' && message.type === 'head') {
          const status = message.status;
          if (
            typeof status !== 'number' ||
            !Number.isInteger(status) ||
            status < 200 ||
            status > 599
          ) {
            stop(new TypeError('The Companion relay returned an invalid response.'));
            return;
          }
          const headers = new Headers();
          if (typeof message.contentType === 'string' && message.contentType.length <= 256)
            headers.set('content-type', message.contentType);
          if (
            typeof message.providerRequestId === 'string' &&
            PROVIDER_REQUEST_ID.test(message.providerRequestId)
          )
            headers.set('x-request-id', message.providerRequestId);
          state = 'streaming';
          const nullBody = status === 204 || status === 205 || status === 304;
          const stream = nullBody
            ? null
            : new ReadableStream<Uint8Array>({
                start(created) {
                  controller = created;
                },
                pull() {
                  if (queue.length > 0 || ended) {
                    deliver();
                    return;
                  }
                  return new Promise<void>((wake) => {
                    pulling = wake;
                  });
                },
                cancel() {
                  channel?.post({ type: 'cancel', requestId: id });
                  state = 'done';
                  signal?.removeEventListener('abort', onAbort);
                  channel?.close();
                },
              });
          resolve(new Response(stream, { status, headers }));
          return;
        }
        if (state !== 'streaming') {
          stop(new TypeError('The Companion relay returned an invalid response.'));
          return;
        }
        if (message.type === 'chunk') {
          if (message.sequence !== expected || typeof message.data !== 'string') {
            stop(new TypeError('The Companion relay returned an invalid response.'));
            return;
          }
          expected += 1;
          queue.push(encoder.encode(message.data));
          if (pulling !== undefined) deliver();
        } else if (message.type === 'end') {
          ended = true;
          if (pulling !== undefined || queue.length === 0) deliver();
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        channel = openPort(options, onMessage, () => {
          if (!ended) stop(new TypeError('The Companion relay disconnected.'));
        });
      } catch {
        stop(new TypeError('The Loom.js Companion is unavailable.'));
        return;
      }
      channel.post({
        type: 'fetch',
        requestId: id,
        target,
        ...(authorization === undefined ? {} : { authorization }),
        ...(body === undefined ? {} : { body }),
      });
    });
  };
}

/** Builds the helper for a status already reported as available. */
export function createCompanionChatGPTHelper(
  options: CreateCompanionChatGPTHelperOptions,
): CompanionChatGPTHelper {
  if (
    !isRecord(options) ||
    typeof options.redirectUri !== 'string' ||
    !REDIRECT_URI.test(options.redirectUri)
  )
    throw new TypeError('Invalid Companion ChatGPT helper redirect URI.');
  const redirectBroker = createRedirectBroker(options);
  const fetch = createRelayFetch(options);
  return Object.freeze({
    redirectBroker,
    fetch,
    clientOptions: Object.freeze({ redirectBroker, fetch }),
  });
}

/**
 * Returns the helper when the Companion is installed, this exact origin is approved, and the user
 * enabled the helper; otherwise `helper` is undefined and `status.reason` says why.
 */
export async function connectCompanionChatGPTHelper(
  options: CompanionChatGPTHelperOptions,
): Promise<{
  readonly status: CompanionChatGPTHelperStatus;
  readonly helper?: CompanionChatGPTHelper;
}> {
  const status = await getCompanionChatGPTHelperStatus(options);
  if (!status.available) return Object.freeze({ status });
  return Object.freeze({
    status,
    helper: createCompanionChatGPTHelper({ ...options, redirectUri: status.redirectUri }),
  });
}
