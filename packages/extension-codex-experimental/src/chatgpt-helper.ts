import {
  messageSenderOrigin,
  type ChromeExternalMessageListener,
  type ChromeMessageSender,
  type ChromeStorageArea,
  type OriginAuthorizer,
} from '@mgravey/loom-extension';

import type { ChromeDeclarativeNetRequestApi, CodexExternalPort } from './chrome-contracts.js';

/**
 * Generic ChatGPT sign-in helper for approved websites.
 *
 * The website runs OpenAI's open-source "Sign in with ChatGPT" flow itself and keeps every token in
 * its own memory. The extension only (1) owns the sign-in popup and turns the browser's navigation
 * to the registered loopback callback into a message for the initiating port, and (2) relays four
 * fixed OpenAI requests whose successful responses carry no CORS headers. Nothing here is specific
 * to a website: every operation requires the user's exact-origin approval and the helper opt-in.
 */
export const CHATGPT_HELPER_PROTOCOL = 'loom/chatgpt-helper' as const;
export const CHATGPT_HELPER_VERSION = 1 as const;
export const CHATGPT_HELPER_PORT_NAME = 'loom/chatgpt-helper/v1' as const;
export const CHATGPT_HELPER_CALLBACK_PROTOCOL = 'loom/chatgpt-helper-callback' as const;
/** Fixed loopback port. Nothing listens on it; the navigation is rewritten before it is sent. */
export const CHATGPT_HELPER_CALLBACK_PORT = 1456 as const;
export const CHATGPT_HELPER_REDIRECT_URI = 'http://127.0.0.1:1456/auth/callback' as const;
export const CHATGPT_HELPER_CALLBACK_PAGE = 'chatgpt-callback.html' as const;
export const CHATGPT_HELPER_ENABLED_KEY = 'loom.chatgpt-helper.enabled' as const;
/** Optional host permissions requested when the user enables the helper. */
export const CHATGPT_HELPER_HOST_PERMISSIONS = Object.freeze([
  'https://api.openai.com/*',
  'http://127.0.0.1/*',
] as const);
export const CHATGPT_HELPER_RULE_ID_BASE = 1_456_100 as const;
export const CHATGPT_HELPER_MAX_ATTEMPTS = 4 as const;
export const CHATGPT_HELPER_MAX_ATTEMPTS_PER_ORIGIN = 2 as const;
export const CHATGPT_HELPER_MAX_RELAYS = 32 as const;
export const CHATGPT_HELPER_MAX_RELAYS_PER_ORIGIN = 8 as const;
export const CHATGPT_HELPER_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
/** Unacknowledged chunks the extension may have in flight on one relay port. */
export const CHATGPT_HELPER_CHUNK_WINDOW = 8 as const;
/** Grace period for the page to close a port after a terminal message. */
export const CHATGPT_HELPER_TERMINAL_GRACE_MS = 5_000 as const;

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const ATTEMPT_PARAMETER = 'loom_attempt';
const MAXIMUM_REQUEST_BODY_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_ERROR_BODY_BYTES = 16 * 1024;
const REQUEST_ID = /^[a-zA-Z0-9._:-]{1,256}$/u;
const STATE = /^[A-Za-z0-9_-]{16,256}$/u;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{1,16384}$/u;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONTENT_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(?:\s*;[\x20-\x7e]{0,128})?$/u;

export type ChatGPTHelperTarget = 'openid-configuration' | 'jwks' | 'models' | 'responses';

interface TargetPolicy {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly bearer: boolean;
  readonly body: boolean;
  readonly accept: string;
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}

/** The complete relay allowlist. No other URL, method, or header can be reached. */
export const CHATGPT_HELPER_TARGETS: Readonly<Record<ChatGPTHelperTarget, TargetPolicy>> =
  Object.freeze({
    'openid-configuration': Object.freeze({
      url: 'https://auth.openai.com/.well-known/openid-configuration',
      method: 'GET',
      bearer: false,
      body: false,
      accept: 'application/json',
      maximumBytes: 64 * 1024,
      timeoutMs: 30_000,
    }),
    jwks: Object.freeze({
      url: 'https://auth.openai.com/.well-known/jwks.json',
      method: 'GET',
      bearer: false,
      body: false,
      accept: 'application/json',
      maximumBytes: 64 * 1024,
      timeoutMs: 30_000,
    }),
    models: Object.freeze({
      url: 'https://api.openai.com/v1/models',
      method: 'GET',
      bearer: true,
      body: false,
      accept: 'application/json',
      maximumBytes: 4 * 1024 * 1024,
      timeoutMs: 60_000,
    }),
    responses: Object.freeze({
      url: 'https://api.openai.com/v1/responses',
      method: 'POST',
      bearer: true,
      body: true,
      accept: 'text/event-stream',
      maximumBytes: 64 * 1024 * 1024,
      timeoutMs: 15 * 60 * 1_000,
    }),
  });

/** Stable failure codes sent to the page. No provider body or exception text is ever attached. */
export type ChatGPTHelperErrorCode =
  | 'UNAUTHORIZED_REQUEST'
  | 'HELPER_DISABLED'
  | 'INVALID_REQUEST'
  | 'BUSY'
  | 'SIGN_IN_CANCELLED'
  | 'SIGN_IN_EXPIRED'
  | 'WINDOW_UNAVAILABLE'
  | 'CALLBACK_REJECTED'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TOO_LARGE'
  | 'DEADLINE_EXCEEDED';

export interface ChatGPTHelperFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type ChatGPTHelperFetch = (
  input: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: 'omit';
    readonly cache: 'no-store';
    readonly redirect: 'error';
    readonly referrerPolicy: 'no-referrer';
    readonly signal: AbortSignal;
  },
) => Promise<ChatGPTHelperFetchResponse>;

export interface ChatGPTHelperWindowsApi {
  create(options: {
    readonly url: string;
    readonly type: 'popup';
    readonly width: number;
    readonly height: number;
    readonly focused: boolean;
  }): Promise<{ readonly id?: number; readonly tabs?: readonly { readonly id?: number }[] }>;
  remove(windowId: number): Promise<void>;
}

export interface ChatGPTHelperChromeApi {
  readonly runtime: { readonly id: string; getURL(path: string): string };
  readonly windows: ChatGPTHelperWindowsApi;
  readonly tabs: {
    update(tabId: number, options: { readonly url: string }): Promise<unknown>;
    readonly onRemoved: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
  };
  readonly declarativeNetRequest: ChromeDeclarativeNetRequestApi;
  readonly permissions?: { contains(details: { origins: string[] }): Promise<boolean> };
  readonly storage: { readonly local: ChromeStorageArea };
}

export interface ChatGPTHelperCallbackSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: { readonly id?: number };
}

export interface CreateChatGPTHelperOptions {
  readonly chromeApi: ChatGPTHelperChromeApi;
  readonly fetch: ChatGPTHelperFetch;
  /** Manifest routing policy: which origins may ask at all. */
  readonly manifestAuthorizer: OriginAuthorizer;
  /** Exact-origin user approval. Required for every operation and every message. */
  readonly authorizer: OriginAuthorizer;
  readonly random?: (bytes: Uint8Array) => Uint8Array;
}

export interface ChatGPTHelper {
  /** Handles one-shot `getStatus` messages from websites. */
  readonly externalMessageListener: ChromeExternalMessageListener;
  /** Handles ports named `CHATGPT_HELPER_PORT_NAME`; ignores all other ports. */
  portListener(port: CodexExternalPort): void;
  /** Handles the extension's own callback page. Returns `undefined` for unrelated messages. */
  callbackMessageListener(
    message: unknown,
    sender: ChatGPTHelperCallbackSender,
    sendResponse: (response: unknown) => void,
  ): boolean | undefined;
  /** Removes rules left behind by a service worker that stopped mid-attempt. */
  removeStaleRules(): Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function isChatGPTHelperRequest(value: unknown): boolean {
  return isRecord(value) && value.protocol === CHATGPT_HELPER_PROTOCOL;
}

class HelperFailure extends Error {
  public readonly code: ChatGPTHelperErrorCode;
  public constructor(code: ChatGPTHelperErrorCode) {
    super(code);
    this.code = code;
  }
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function envelope(value: Readonly<Record<string, unknown>>, type: string): boolean {
  return (
    value.protocol === CHATGPT_HELPER_PROTOCOL &&
    value.version === CHATGPT_HELPER_VERSION &&
    value.type === type &&
    typeof value.requestId === 'string' &&
    REQUEST_ID.test(value.requestId)
  );
}

/** Validates the page's authorization URL: OpenAI's endpoint, our redirect, PKCE S256, its state. */
function validAuthorizationUrl(value: unknown, state: string): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (`${url.origin}${url.pathname}` !== AUTHORIZE_URL || url.hash || url.username || url.password)
    return undefined;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return undefined;
  const parameters = url.searchParams;
  if (
    parameters.get('redirect_uri') !== CHATGPT_HELPER_REDIRECT_URI ||
    parameters.get('response_type') !== 'code' ||
    parameters.get('code_challenge_method') !== 'S256' ||
    (parameters.get('code_challenge') ?? '') === '' ||
    (parameters.get('client_id') ?? '') === '' ||
    parameters.get('state') !== state
  )
    return undefined;
  return url.href;
}

interface Attempt {
  readonly id: string;
  readonly requestId: string;
  readonly origin: string;
  readonly state: string;
  readonly ruleId: number;
  windowId?: number | undefined;
  tabId?: number | undefined;
  settle(message: Readonly<Record<string, unknown>>): void;
}

export function createChatGPTHelper(options: CreateChatGPTHelperOptions): ChatGPTHelper {
  const chromeApi = options.chromeApi;
  const random =
    options.random ?? ((bytes: Uint8Array) => globalThis.crypto.getRandomValues(bytes));
  const attempts = new Map<string, Attempt>();
  const relays = new Map<string, number>();
  let relayCount = 0;

  const callbackPageUrl = (): string => chromeApi.runtime.getURL(CHATGPT_HELPER_CALLBACK_PAGE);

  async function enabled(): Promise<boolean> {
    try {
      const values = await chromeApi.storage.local.get(CHATGPT_HELPER_ENABLED_KEY);
      if (values[CHATGPT_HELPER_ENABLED_KEY] !== true) return false;
      return (
        (await chromeApi.permissions?.contains({
          origins: [...CHATGPT_HELPER_HOST_PERMISSIONS],
        })) === true
      );
    } catch {
      return false;
    }
  }

  /** Exact-origin approval and helper opt-in. Throws a coded failure; never reveals why to others. */
  async function authorize(sender: ChromeMessageSender): Promise<string> {
    try {
      await options.authorizer.assertAuthorized(sender);
    } catch {
      throw new HelperFailure('UNAUTHORIZED_REQUEST');
    }
    const origin = messageSenderOrigin(sender);
    if (origin === undefined) throw new HelperFailure('UNAUTHORIZED_REQUEST');
    if (!(await enabled())) throw new HelperFailure('HELPER_DISABLED');
    return origin;
  }

  const externalMessageListener: ChromeExternalMessageListener = (
    message,
    sender,
    sendResponse,
  ) => {
    void (async () => {
      const requestId =
        isRecord(message) &&
        typeof message.requestId === 'string' &&
        REQUEST_ID.test(message.requestId)
          ? message.requestId
          : 'invalid-request';
      const reply = (body: Readonly<Record<string, unknown>>): void =>
        sendResponse(
          Object.freeze({
            protocol: CHATGPT_HELPER_PROTOCOL,
            version: CHATGPT_HELPER_VERSION,
            type: 'status',
            requestId,
            ...body,
          }),
        );
      try {
        await options.manifestAuthorizer.assertAuthorized(sender);
      } catch {
        reply({ ok: false, error: { code: 'UNAUTHORIZED_REQUEST' } });
        return;
      }
      if (
        !isRecord(message) ||
        !envelope(message, 'getStatus') ||
        !hasOnlyKeys(message, ['protocol', 'version', 'type', 'requestId'])
      ) {
        reply({ ok: false, error: { code: 'INVALID_REQUEST' } });
        return;
      }
      let approved = true;
      try {
        await options.authorizer.assertAuthorized(sender);
      } catch {
        approved = false;
      }
      if (!approved) {
        reply({ ok: true, approved: false });
        return;
      }
      reply({
        ok: true,
        approved: true,
        enabled: await enabled(),
        redirectUri: CHATGPT_HELPER_REDIRECT_URI,
      });
    })();
    return true;
  };

  async function removeRule(ruleId: number): Promise<void> {
    try {
      await chromeApi.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    } catch {
      // Rules are session-scoped and are removed again on the next service-worker start.
    }
  }

  function freeRuleId(): number | undefined {
    const used = new Set([...attempts.values()].map((attempt) => attempt.ruleId));
    for (let index = 0; index < CHATGPT_HELPER_MAX_ATTEMPTS; index += 1) {
      const id = CHATGPT_HELPER_RULE_ID_BASE + index;
      if (!used.has(id)) return id;
    }
    return undefined;
  }

  function handlePort(port: CodexExternalPort): void {
    const sender = port.sender ?? {};
    let state: 'idle' | 'busy' | 'terminal' | 'closed' = 'idle';
    let cleanup: (() => void) | undefined;
    let onIncoming: ((message: Readonly<Record<string, unknown>>) => void) | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let approvedAt = 0;
    let activeRequestId = 'invalid-request';
    /** Read through a function: other callbacks change `state` while an operation awaits. */
    const running = (): boolean => state === 'busy';

    /** Returns false when the port is closed (or closes because posting failed). */
    const post = (message: Readonly<Record<string, unknown>>): boolean => {
      if (state === 'closed') return false;
      try {
        port.postMessage(
          Object.freeze({
            protocol: CHATGPT_HELPER_PROTOCOL,
            version: CHATGPT_HELPER_VERSION,
            ...message,
          }),
        );
        return true;
      } catch {
        close();
        return false;
      }
    };
    const close = (): void => {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(graceTimer);
      port.onMessage.removeListener?.(onMessage);
      port.onDisconnect.removeListener?.(onDisconnect);
      cleanup?.();
      cleanup = undefined;
      try {
        port.disconnect();
      } catch {
        // The page may already have disconnected.
      }
    };
    /** Sends one terminal message, then leaves the page a grace period to close the port. */
    const terminal = (message: Readonly<Record<string, unknown>>): void => {
      if (state === 'closed' || state === 'terminal') return;
      if (!post(message)) return;
      state = 'terminal';
      cleanup?.();
      cleanup = undefined;
      graceTimer = setTimeout(close, CHATGPT_HELPER_TERMINAL_GRACE_MS);
    };
    const fail = (requestId: string, error: unknown): void =>
      terminal({
        type: 'error',
        requestId,
        code: error instanceof HelperFailure ? error.code : 'INVALID_REQUEST',
      });

    function onDisconnect(): void {
      close();
    }

    function onMessage(untrusted: unknown): void {
      if (state === 'closed' || state === 'terminal') return;
      if (state === 'busy') {
        if (!isRecord(untrusted)) return;
        // Approval is re-checked while an operation runs, so revocation stops it promptly.
        const now = Date.now();
        if (now - approvedAt > 1_000) {
          approvedAt = now;
          void authorize(sender).catch((error: unknown) => {
            fail(activeRequestId, error);
          });
        }
        onIncoming?.(untrusted);
        return;
      }
      state = 'busy';
      const requestId =
        isRecord(untrusted) &&
        typeof untrusted.requestId === 'string' &&
        REQUEST_ID.test(untrusted.requestId)
          ? untrusted.requestId
          : 'invalid-request';
      activeRequestId = requestId;
      void (async () => {
        try {
          const origin = await authorize(sender);
          approvedAt = Date.now();
          if (!running()) return;
          if (!isRecord(untrusted)) throw new HelperFailure('INVALID_REQUEST');
          if (envelope(untrusted, 'authorize')) await startAuthorize(origin, requestId, untrusted);
          else if (envelope(untrusted, 'fetch')) await startRelay(origin, requestId, untrusted);
          else throw new HelperFailure('INVALID_REQUEST');
        } catch (error) {
          fail(requestId, error);
        }
      })();
    }

    async function startAuthorize(
      origin: string,
      requestId: string,
      request: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      if (
        !hasOnlyKeys(request, [
          'protocol',
          'version',
          'type',
          'requestId',
          'authorizationUrl',
          'state',
        ])
      )
        throw new HelperFailure('INVALID_REQUEST');
      const oauthState = request.state;
      if (typeof oauthState !== 'string' || !STATE.test(oauthState))
        throw new HelperFailure('INVALID_REQUEST');
      const authorizationUrl = validAuthorizationUrl(request.authorizationUrl, oauthState);
      if (authorizationUrl === undefined) throw new HelperFailure('INVALID_REQUEST');
      const sameOrigin = [...attempts.values()].filter((item) => item.origin === origin).length;
      const ruleId = freeRuleId();
      if (sameOrigin >= CHATGPT_HELPER_MAX_ATTEMPTS_PER_ORIGIN || ruleId === undefined)
        throw new HelperFailure('BUSY');
      const id = base64url(random(new Uint8Array(32)));
      const expiry = setTimeout(
        () => terminal({ type: 'error', requestId, code: 'SIGN_IN_EXPIRED' }),
        CHATGPT_HELPER_ATTEMPT_TTL_MS,
      );
      const attempt: Attempt = {
        id,
        requestId,
        origin,
        state: oauthState,
        ruleId,
        settle: (message) => terminal({ ...message, requestId }),
      };
      const onTabRemoved = (tabId: number): void => {
        if (tabId !== attempt.tabId) return;
        attempt.windowId = undefined;
        terminal({ type: 'error', requestId, code: 'SIGN_IN_CANCELLED' });
      };
      attempts.set(id, attempt);
      cleanup = () => {
        clearTimeout(expiry);
        chromeApi.tabs.onRemoved.removeListener(onTabRemoved);
        attempts.delete(id);
        void removeRule(ruleId);
        if (attempt.windowId !== undefined) {
          const windowId = attempt.windowId;
          attempt.windowId = undefined;
          void chromeApi.windows.remove(windowId).catch(() => undefined);
        }
      };
      onIncoming = (message) => {
        if (message.type === 'cancel')
          terminal({ type: 'error', requestId, code: 'SIGN_IN_CANCELLED' });
      };
      chromeApi.tabs.onRemoved.addListener(onTabRemoved);
      let created: Awaited<ReturnType<ChatGPTHelperWindowsApi['create']>>;
      try {
        created = await chromeApi.windows.create({
          url: 'about:blank',
          type: 'popup',
          width: 560,
          height: 760,
          focused: true,
        });
      } catch {
        throw new HelperFailure('WINDOW_UNAVAILABLE');
      }
      const tabId = created.tabs?.[0]?.id;
      if (typeof created.id === 'number') attempt.windowId = created.id;
      if (!running()) {
        // The page went away while Chrome created the window.
        if (attempt.windowId !== undefined)
          await chromeApi.windows.remove(attempt.windowId).catch(() => undefined);
        return;
      }
      if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId))
        throw new HelperFailure('WINDOW_UNAVAILABLE');
      attempt.tabId = tabId;
      try {
        await routeCallback(tabId, ruleId, id);
        if (!running()) return;
        await chromeApi.tabs.update(tabId, { url: authorizationUrl });
      } catch {
        throw new HelperFailure('WINDOW_UNAVAILABLE');
      }
      post({ type: 'authorizing', requestId });
    }

    /** Tab-scoped: a real server on this port, and every other tab, are unaffected. */
    async function routeCallback(tabId: number, ruleId: number, id: string): Promise<void> {
      await chromeApi.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: 'redirect',
              redirect: {
                regexSubstitution: `${callbackPageUrl()}?${ATTEMPT_PARAMETER}=${id}&\\1`,
              },
            },
            condition: {
              regexFilter: `^http://127\\.0\\.0\\.1:${String(CHATGPT_HELPER_CALLBACK_PORT)}/auth/callback(?:\\?(.*))?$`,
              resourceTypes: ['main_frame'],
              tabIds: [tabId],
            },
          },
        ],
      });
    }

    async function startRelay(
      origin: string,
      requestId: string,
      request: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      if (
        !hasOnlyKeys(request, [
          'protocol',
          'version',
          'type',
          'requestId',
          'target',
          'authorization',
          'body',
        ]) ||
        typeof request.target !== 'string' ||
        !Object.hasOwn(CHATGPT_HELPER_TARGETS, request.target)
      )
        throw new HelperFailure('INVALID_REQUEST');
      const policy = CHATGPT_HELPER_TARGETS[request.target as ChatGPTHelperTarget];
      const headers: Record<string, string> = { Accept: policy.accept };
      if (policy.bearer) {
        if (typeof request.authorization !== 'string' || !BEARER.test(request.authorization))
          throw new HelperFailure('INVALID_REQUEST');
        headers.Authorization = request.authorization;
      } else if (request.authorization !== undefined) throw new HelperFailure('INVALID_REQUEST');
      let body: string | undefined;
      if (policy.body) {
        if (typeof request.body !== 'string' || request.body.length > MAXIMUM_REQUEST_BODY_LENGTH)
          throw new HelperFailure('INVALID_REQUEST');
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.body);
        } catch {
          throw new HelperFailure('INVALID_REQUEST');
        }
        if (!isRecord(parsed)) throw new HelperFailure('INVALID_REQUEST');
        body = request.body;
        headers['Content-Type'] = 'application/json';
      } else if (request.body !== undefined) throw new HelperFailure('INVALID_REQUEST');
      const sameOrigin = relays.get(origin) ?? 0;
      if (
        sameOrigin >= CHATGPT_HELPER_MAX_RELAYS_PER_ORIGIN ||
        relayCount >= CHATGPT_HELPER_MAX_RELAYS
      )
        throw new HelperFailure('BUSY');
      relays.set(origin, sameOrigin + 1);
      relayCount += 1;
      const controller = new AbortController();
      const deadlineState = { exceeded: false };
      const deadline = setTimeout(() => {
        deadlineState.exceeded = true;
        controller.abort();
      }, policy.timeoutMs);
      let credits: number = CHATGPT_HELPER_CHUNK_WINDOW;
      let waiter: (() => void) | undefined;
      let released = false;
      cleanup = () => {
        if (released) return;
        released = true;
        clearTimeout(deadline);
        controller.abort();
        waiter?.();
        const remaining = (relays.get(origin) ?? 1) - 1;
        if (remaining <= 0) relays.delete(origin);
        else relays.set(origin, remaining);
        relayCount -= 1;
      };
      onIncoming = (message) => {
        if (message.type === 'cancel') {
          close();
          return;
        }
        if (
          message.type === 'ack' &&
          message.requestId === requestId &&
          credits < CHATGPT_HELPER_CHUNK_WINDOW
        ) {
          credits += 1;
          const wake = waiter;
          waiter = undefined;
          wake?.();
        }
      };
      let response: ChatGPTHelperFetchResponse;
      try {
        response = await options.fetch(policy.url, {
          method: policy.method,
          headers: Object.freeze(headers),
          ...(body === undefined ? {} : { body }),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch {
        throw new HelperFailure(
          deadlineState.exceeded ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_UNREACHABLE',
        );
      }
      if (!running()) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const ok = response.status >= 200 && response.status < 300;
      const contentType = response.headers.get('content-type');
      const providerRequestId = response.headers.get('x-request-id');
      post({
        type: 'head',
        requestId,
        status: response.status,
        ...(contentType !== null && CONTENT_TYPE.test(contentType) ? { contentType } : {}),
        ...(providerRequestId !== null && PROVIDER_REQUEST_ID.test(providerRequestId)
          ? { providerRequestId }
          : {}),
      });
      const reader = response.body?.getReader();
      const limit = ok ? policy.maximumBytes : MAXIMUM_ERROR_BODY_BYTES;
      const decoder = new TextDecoder();
      let total = 0;
      let sequence = 0;
      const send = async (data: string): Promise<boolean> => {
        if (data === '') return true;
        while (credits <= 0 && running())
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        if (!running()) return false;
        credits -= 1;
        post({ type: 'chunk', requestId, sequence, data });
        sequence += 1;
        return true;
      };
      try {
        if (reader !== undefined) {
          for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await reader.read();
            } catch {
              throw new HelperFailure(
                deadlineState.exceeded ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_UNREACHABLE',
              );
            }
            if (!running()) return;
            if (chunk.done) break;
            const room = limit - total;
            total += chunk.value.byteLength;
            if (total > limit) {
              if (ok) throw new HelperFailure('UPSTREAM_TOO_LARGE');
              // Error bodies are only classified by the page: pass the first bytes, then stop.
              if (!(await send(decoder.decode(chunk.value.subarray(0, room), { stream: true }))))
                return;
              break;
            }
            if (!(await send(decoder.decode(chunk.value, { stream: true })))) return;
          }
          if (!(await send(decoder.decode()))) return;
        }
        terminal({ type: 'end', requestId });
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
    }

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  return Object.freeze({
    externalMessageListener,
    portListener(port: CodexExternalPort) {
      // Authorization runs on the first message; unapproved ports get one error and are closed.
      if (port.name === CHATGPT_HELPER_PORT_NAME) handlePort(port);
    },
    callbackMessageListener(
      message: unknown,
      sender: ChatGPTHelperCallbackSender,
      sendResponse: (response: unknown) => void,
    ) {
      if (!isRecord(message) || message.protocol !== CHATGPT_HELPER_CALLBACK_PROTOCOL)
        return undefined;
      const tabId = sender.tab?.id;
      const page = callbackPageUrl();
      const search = message.search;
      let accepted = false;
      const attempt =
        typeof tabId === 'number'
          ? [...attempts.values()].find((item) => item.tabId === tabId)
          : undefined;
      if (
        attempt !== undefined &&
        sender.id === chromeApi.runtime.id &&
        typeof sender.url === 'string' &&
        (sender.url === page ||
          sender.url.startsWith(`${page}?`) ||
          sender.url.startsWith(`${page}#`)) &&
        message.version === CHATGPT_HELPER_VERSION &&
        hasOnlyKeys(message, ['protocol', 'version', 'search']) &&
        typeof search === 'string' &&
        search.length <= 16_384 &&
        search.startsWith('?')
      ) {
        // The rule puts this attempt's identifier first; the provider's query follows verbatim.
        const prefix = `?${ATTEMPT_PARAMETER}=${attempt.id}&`;
        const query = search.startsWith(prefix) ? search.slice(prefix.length) : undefined;
        const parameters = new URLSearchParams(query ?? '');
        const states = parameters.getAll('state');
        if (
          query !== undefined &&
          !parameters.has(ATTEMPT_PARAMETER) &&
          states.length === 1 &&
          states[0] === attempt.state
        ) {
          accepted = true;
          attempt.settle({ type: 'callback', url: `${CHATGPT_HELPER_REDIRECT_URI}?${query}` });
        } else {
          attempt.settle({ type: 'error', code: 'CALLBACK_REJECTED' });
        }
      }
      sendResponse(Object.freeze({ ok: accepted }));
      return undefined;
    },
    async removeStaleRules() {
      const ids = Array.from(
        { length: CHATGPT_HELPER_MAX_ATTEMPTS },
        (_, index) => CHATGPT_HELPER_RULE_ID_BASE + index,
      ).filter((id) => ![...attempts.values()].some((attempt) => attempt.ruleId === id));
      try {
        await chromeApi.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
      } catch {
        // Nothing else can be done; stale rules are tab-scoped to closed sign-in windows.
      }
    },
  });
}
