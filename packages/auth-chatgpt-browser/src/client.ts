import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { CancellationError, type CancellationSignal } from '@mgravey/loom-types';
import {
  OpenAIResponsesModelError,
  type OpenAICompatibleResponsesTransport,
  type OpenAIResponsesRequest,
} from '@mgravey/loom-model-openai-responses';

import {
  AUTH_ORIGIN,
  AUTHORIZE_ENDPOINT,
  CHATGPT_BROWSER_DEFAULT_CALLBACK_PATH,
  CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE,
  CHATGPT_BROWSER_DEFAULT_STORAGE_PREFIX,
  DISCOVERY_ENDPOINT,
  DYNAMIC_CLIENT_ID,
  PLAN_SCOPE,
  RESOURCE,
  SCOPES,
  TOKEN_ENDPOINT,
  validCallbackPath,
  validMessageType,
} from './constants.js';
import {
  detectChatGPTBrowserSupport,
  type ChatGPTBrowserUnsupportedReason,
} from './environment.js';
import { ChatGPTBrowserError, chatgptError, type ChatGPTBrowserTokenErrorCode } from './errors.js';
import {
  bounded,
  discardBody,
  fetchSafe,
  jsonSafe,
  readJson,
  record,
  resourceFailure,
  type FetchFunction,
} from './http.js';
import { shapeRequest, shapeStream } from './stream.js';

/** Non-secret metadata storage. Tokens and login transactions are never written to it. */
export interface ChatGPTBrowserMetadataStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Host-authored user-facing notices. Error messages remain sanitized library text. */
export interface ChatGPTBrowserNotices {
  /** Shown while no other notice applies. Omitted by default. */
  readonly ready?: string;
  /** Shown after a verified sign-in that did not grant `chatgpt.tokens.use.direct`. */
  readonly planNotGranted: string;
  /** Shown after local sign-out when remote revocation was not confirmed. */
  readonly revocationUnconfirmed: string;
  /** Shown, and used as the sign-in rejection message, on unsupported pages. */
  unsupported(reason: ChatGPTBrowserUnsupportedReason): string;
}

/**
 * Opaque, versioned record that lets a host resume a verified session in a later page. It contains a
 * refresh token: treat the whole value as a secret. Hosts store it as-is and never inspect it; the
 * client re-validates it with a refresh and ID-token verification before using it.
 */
export interface ChatGPTBrowserPersistedSession {
  readonly format: 'loom.chatgpt-browser.session';
  readonly version: 1;
  /** Issued public client ID (`oaiapp_…`) the refresh token belongs to. */
  readonly clientId: string;
  /** Verified ID-token subject; a restore that returns another subject is rejected. */
  readonly subject: string;
  readonly email?: string;
  /** Original sign-in nonce, compared when a refreshed ID token repeats it. */
  readonly nonce: string;
  /** Last granted scopes, used only when a refresh response omits `scope`. */
  readonly scopes: readonly string[];
  readonly refreshToken: string;
  /** Epoch milliseconds of this record. */
  readonly savedAt: number;
}

/**
 * Host-implemented store for one persisted session. Every method must settle (apply your own
 * timeouts). The client serializes calls in order, so a `clear()` issued after a `save()` always
 * runs after that save settles. Failures are swallowed and never reach sign-in or errors.
 */
export interface ChatGPTBrowserSessionStore {
  /** Returns the last saved value, or `null`/`undefined` when nothing is stored. */
  load(): Promise<unknown>;
  save(session: ChatGPTBrowserPersistedSession): Promise<void>;
  clear(): Promise<void>;
}

/**
 * - `restored`: a stored session was refreshed, verified, and is now active.
 * - `none`: no store, nothing stored, or the page cannot use ChatGPT sign-in.
 * - `discarded`: the stored value was malformed or confirmed unusable and was cleared.
 * - `unavailable`: the store or ChatGPT could not be reached; the stored value is kept.
 * - `superseded`: a sign-in, sign-out, or disposal happened first; nothing was applied.
 */
export type ChatGPTBrowserRestoreResult =
  'restored' | 'none' | 'discarded' | 'unavailable' | 'superseded';

export interface ChatGPTBrowserClientOptions {
  /** Sent as `agent_name_hint` on first registration. Use the same value on every installation. */
  readonly appName: string;
  /** Loopback callback path served by the host. Defaults to `/auth/callback`. */
  readonly callbackPath?: string;
  /** `postMessage` type shared with `completeChatGPTBrowserCallback`. */
  readonly messageType?: string;
  /**
   * Storage for non-secret registration and host metadata. Defaults to `window.localStorage`;
   * `null` keeps metadata in memory only.
   */
  readonly storage?: ChatGPTBrowserMetadataStorage | null;
  /** Defaults to `loom.chatgpt-browser.`. */
  readonly storageKeyPrefix?: string;
  readonly notices?: Partial<ChatGPTBrowserNotices>;
  /** Namespace wrapping host function tools in plan-usage requests. */
  readonly toolNamespace?: { readonly name?: string; readonly description?: string };
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchFunction;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Opt-in persistence for resuming a session after a reload. Omitted by default: sessions then
   * live in memory only. The host decides where the value is kept; browser storage is discouraged.
   */
  readonly sessionStore?: ChatGPTBrowserSessionStore;
  /** Sign-in attempt lifetime. Defaults to 5 minutes. */
  readonly signInTimeoutMs?: number;
  /** Total lifetime of one model or catalog request. Defaults to 10 minutes. */
  readonly requestTimeoutMs?: number;
}

export interface ChatGPTBrowserAccount {
  /** The issued public client ID (`oaiapp_…`). */
  readonly id: string;
  readonly label: string;
  /** False until an ID token for this registration has been verified. */
  readonly verified: boolean;
}

export interface ChatGPTBrowserStatus {
  readonly supported: boolean;
  readonly unsupportedReason?: ChatGPTBrowserUnsupportedReason;
  readonly authenticated: boolean;
  readonly planEnabled: boolean;
  readonly signingIn: boolean;
  /** True while `restoreSession()` is validating a stored session. */
  readonly restoring?: boolean;
  readonly accountLabel?: string;
  readonly activeAccountId?: string;
  readonly accounts: readonly ChatGPTBrowserAccount[];
  readonly notice?: string;
}

export interface ChatGPTBrowserModel {
  readonly slug: string;
  readonly displayName: string;
}

export interface ChatGPTBrowserClient {
  /** Returns a cached immutable snapshot; a new object is returned only after a change. */
  getStatus(): ChatGPTBrowserStatus;
  /** Notifies after every status change. Returns an unsubscribe function. */
  subscribe(listener: (status: ChatGPTBrowserStatus) => void): () => void;
  /** Call synchronously from a user gesture: the popup opens before any await. */
  signIn(accountId?: string): Promise<void>;
  cancelSignIn(): void;
  /**
   * Stops requests, attempts revocation, then clears tokens. Registrations are kept. With a
   * `sessionStore`, also clears the stored session.
   */
  signOut(): Promise<{ readonly revoked: boolean }>;
  /**
   * Resumes a session from `sessionStore` without a popup: refreshes the stored refresh token and
   * verifies the returned ID token. Single-flight; never throws.
   */
  restoreSession(): Promise<ChatGPTBrowserRestoreResult>;
  /** Writes the active session to `sessionStore` (for example after the user opts in). */
  saveSession(): Promise<boolean>;
  /** Clears `sessionStore` without signing out (for example after the user opts out). */
  forgetStoredSession(): Promise<boolean>;
  listModels(): Promise<readonly ChatGPTBrowserModel[]>;
  /** Plug into `createOpenAICompatibleResponsesModel({ model, transport })`. */
  readonly transport: OpenAICompatibleResponsesTransport;
  dispose(): void;
}

interface Registration {
  id: string;
  label: string;
  subject?: string;
  email?: string;
}
interface Tokens {
  access: string;
  refresh?: string;
  id: string;
  expiresAt: number;
  scopes: readonly string[];
}
interface Session {
  registration: Registration;
  nonce: string;
  tokens: Tokens;
  controller: AbortController;
  refreshing?: Promise<void>;
}
interface Attempt {
  popup: Window;
  controller: AbortController;
  state: string;
  nonce: string;
  verifier: string;
  redirect: string;
  selected: Registration | undefined;
  expiresAt: number;
  ready: boolean;
  consumed: boolean;
  finish(error?: Error): void;
}

const EMPTY_TOKENS = (): Tokens => ({ access: '', id: '', expiresAt: 0, scopes: [] });
const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_NOTICES: ChatGPTBrowserNotices = Object.freeze({
  planNotGranted:
    'Signed in, but ChatGPT plan usage was not granted. Models stay disabled for this account.',
  revocationUnconfirmed:
    'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.',
  unsupported: (reason: ChatGPTBrowserUnsupportedReason) =>
    reason === 'origin-not-loopback'
      ? 'Sign in with ChatGPT currently requires this app to be opened at http://127.0.0.1:<port>.'
      : reason === 'web-crypto-unavailable'
        ? 'Sign in with ChatGPT requires Web Crypto in this browser.'
        : reason === 'disposed'
          ? 'This ChatGPT connection was closed.'
          : 'Sign in with ChatGPT requires a browser window.',
});

function clientId(value: unknown): value is string {
  return typeof value === 'string' && /^oaiapp_[a-zA-Z0-9_-]{1,200}$/.test(value);
}
function random(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function authEndpoint(value: unknown): string {
  if (typeof value !== 'string')
    throw chatgptError('sign-in-failed', 'OpenAI discovery did not provide a valid endpoint.');
  const url = new URL(value);
  if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash || url.search) {
    throw chatgptError('sign-in-failed', 'OpenAI discovery returned an untrusted endpoint.');
  }
  return url.href;
}
function positive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive.`);
  return value;
}

const TERMINAL_REFRESH_CODES = new Set<ChatGPTBrowserTokenErrorCode>([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const SESSION_FORMAT = 'loom.chatgpt-browser.session';

function persistedSession(value: unknown): ChatGPTBrowserPersistedSession | undefined {
  if (
    !record(value) ||
    value.format !== SESSION_FORMAT ||
    value.version !== 1 ||
    !clientId(value.clientId) ||
    !bounded(value.subject) ||
    (value.email !== undefined && !bounded(value.email, 200)) ||
    !bounded(value.nonce, 512) ||
    !Array.isArray(value.scopes) ||
    value.scopes.length > 64 ||
    !value.scopes.every((scope) => bounded(scope, 200)) ||
    !bounded(value.refreshToken, 32768) ||
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt)
  )
    return undefined;
  return {
    format: SESSION_FORMAT,
    version: 1,
    clientId: value.clientId,
    subject: value.subject,
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
    nonce: value.nonce,
    scopes: [...value.scopes],
    refreshToken: value.refreshToken,
    savedAt: value.savedAt,
  };
}

/** Creates a browser-only Sign in with ChatGPT client. Credentials stay in this object's memory. */
export function createChatGPTBrowserClient(
  options: ChatGPTBrowserClientOptions,
): ChatGPTBrowserClient {
  if (!record(options) || !bounded(options.appName, 100) || options.appName.trim() === '')
    throw new TypeError('ChatGPT browser client requires a non-empty appName.');
  const appName = options.appName;
  const callbackPath = options.callbackPath ?? CHATGPT_BROWSER_DEFAULT_CALLBACK_PATH;
  const messageType = options.messageType ?? CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE;
  const prefix = options.storageKeyPrefix ?? CHATGPT_BROWSER_DEFAULT_STORAGE_PREFIX;
  if (!validCallbackPath(callbackPath)) throw new TypeError('Invalid ChatGPT callback path.');
  if (!validMessageType(messageType)) throw new TypeError('Invalid ChatGPT callback message type.');
  if (typeof prefix !== 'string' || prefix.length > 200)
    throw new TypeError('Invalid ChatGPT storage key prefix.');
  const namespace = Object.freeze({
    name: options.toolNamespace?.name ?? 'loom',
    description: options.toolNamespace?.description ?? 'Tools provided by the host application.',
  });
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(namespace.name) || !bounded(namespace.description, 1024))
    throw new TypeError('Invalid ChatGPT tool namespace.');
  const notices: ChatGPTBrowserNotices = { ...DEFAULT_NOTICES, ...options.notices };
  const signInTimeout = positive(options.signInTimeoutMs, 5 * 60 * 1000, 'signInTimeoutMs');
  const requestTimeout = positive(options.requestTimeoutMs, 10 * 60 * 1000, 'requestTimeoutMs');
  const now = options.now ?? (() => Date.now());
  const fetch: FetchFunction = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const hostWindow = (globalThis as { readonly window?: Window }).window;
  const support = detectChatGPTBrowserSupport();
  const hostsKey = `${prefix}host.v1`;
  const accountsKey = `${prefix}registrations.v1`;
  let storage: ChatGPTBrowserMetadataStorage | undefined;
  if (options.storage === null) {
    const memory = new Map<string, string>();
    storage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
    };
  } else if (options.storage !== undefined) {
    storage = options.storage;
  } else {
    try {
      storage = hostWindow?.localStorage;
    } catch {
      storage = undefined;
    }
  }

  let disposed = false;
  let session: Session | undefined;
  let attempt: Attempt | undefined;
  let notice: string | undefined = notices.ready;
  let epoch = 0;
  let registrations: Registration[] = [];
  let snapshot: ChatGPTBrowserStatus | undefined;
  const sessionStore = options.sessionStore;
  if (
    sessionStore !== undefined &&
    (!record(sessionStore) ||
      typeof sessionStore.load !== 'function' ||
      typeof sessionStore.save !== 'function' ||
      typeof sessionStore.clear !== 'function')
  )
    throw new TypeError('Invalid ChatGPT session store.');
  let storeQueue: Promise<unknown> = Promise.resolve();
  let restoring: Promise<ChatGPTBrowserRestoreResult> | undefined;
  const listeners = new Set<(status: ChatGPTBrowserStatus) => void>();

  try {
    const raw: unknown = JSON.parse(storage?.getItem(accountsKey) ?? '[]');
    if (Array.isArray(raw) && raw.length <= 100) {
      const seen = new Set<string>();
      registrations = raw.flatMap((item) => {
        if (
          !record(item) ||
          !clientId(item.id) ||
          !bounded(item.label, 500) ||
          seen.has(item.id) ||
          (item.subject !== undefined && !bounded(item.subject)) ||
          (item.email !== undefined && !bounded(item.email, 200))
        )
          return [];
        seen.add(item.id);
        return [
          {
            id: item.id,
            label:
              item.subject === undefined && item.label.startsWith('ChatGPT registration ')
                ? `Unverified ${item.label}`
                : item.label,
            ...(typeof item.subject === 'string' ? { subject: item.subject } : {}),
            ...(typeof item.email === 'string' && typeof item.subject === 'string'
              ? { email: item.email }
              : {}),
          },
        ];
      });
    }
  } catch {
    /* Storage can be unavailable or corrupt; session credentials never use it. */
  }

  function changed(): void {
    snapshot = undefined;
    const current = getStatus();
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch {
        /* A failing observer must not affect authentication state. */
      }
    }
  }
  function getStatus(): ChatGPTBrowserStatus {
    if (snapshot !== undefined) return snapshot;
    const reason = disposed ? 'disposed' : support.reason;
    const shown = reason === undefined ? notice : notices.unsupported(reason);
    snapshot = Object.freeze({
      supported: reason === undefined,
      ...(reason === undefined ? {} : { unsupportedReason: reason }),
      authenticated: session !== undefined,
      planEnabled: session?.tokens.scopes.includes(PLAN_SCOPE) ?? false,
      signingIn: attempt !== undefined,
      restoring: restoring !== undefined,
      ...(session === undefined
        ? {}
        : { accountLabel: session.registration.label, activeAccountId: session.registration.id }),
      accounts: Object.freeze(
        registrations.map(({ id, label, subject }) =>
          Object.freeze({ id, label, verified: subject !== undefined }),
        ),
      ),
      ...(shown === undefined ? {} : { notice: shown }),
    });
    return snapshot;
  }

  function persist(): void {
    // Enumerate allowed fields explicitly: never serialize a session or token response.
    try {
      if (storage === undefined) throw new Error('unavailable');
      storage.setItem(
        accountsKey,
        JSON.stringify(
          registrations.map(({ id, label, subject, email }) => ({
            id,
            label,
            ...(subject === undefined ? {} : { subject }),
            ...(email === undefined ? {} : { email }),
          })),
        ),
      );
    } catch {
      throw chatgptError(
        'storage-unavailable',
        'Browser storage is unavailable. Allow local registration storage and sign in again.',
      );
    }
  }
  /** Runs store operations strictly in order; failures resolve to `false` and stay private. */
  function enqueueStore(
    operation: (store: ChatGPTBrowserSessionStore) => Promise<boolean>,
  ): Promise<boolean> {
    if (sessionStore === undefined) return Promise.resolve(false);
    const run = storeQueue.then(
      () => operation(sessionStore),
      () => operation(sessionStore),
    );
    const settled = run.then(
      (done) => done,
      () => false,
    );
    storeQueue = settled;
    return settled;
  }
  function saveStored(current: Session): Promise<boolean> {
    return enqueueStore(async (store) => {
      // Evaluated when the operation runs: a session replaced or signed out meanwhile is skipped.
      const refreshToken = current.tokens.refresh;
      const subject = current.registration.subject;
      if (disposed || session !== current || refreshToken === undefined || subject === undefined)
        return false;
      await store.save({
        format: SESSION_FORMAT,
        version: 1,
        clientId: current.registration.id,
        subject,
        ...(current.registration.email === undefined ? {} : { email: current.registration.email }),
        nonce: current.nonce,
        scopes: [...current.tokens.scopes],
        refreshToken,
        savedAt: now(),
      });
      return true;
    });
  }
  function clearStored(): Promise<boolean> {
    return enqueueStore(async (store) => {
      await store.clear();
      return true;
    });
  }

  function host(): string {
    try {
      if (storage === undefined) throw new Error('unavailable');
      const saved = storage.getItem(hostsKey);
      if (saved !== null && HOST_ID.test(saved)) return saved;
      const id = `urn:uuid:${globalThis.crypto.randomUUID()}`;
      storage.setItem(hostsKey, id);
      return id;
    } catch {
      throw chatgptError(
        'storage-unavailable',
        'Browser storage is unavailable. Allow local host registration storage and sign in again.',
      );
    }
  }

  async function discover(signal: AbortSignal): Promise<Record<string, unknown>> {
    const data = await jsonSafe(
      await fetchSafe(
        fetch,
        DISCOVERY_ENDPOINT,
        { signal },
        'temporarily-unavailable',
        'The browser could not load OpenAI sign-in configuration. Network or browser access restrictions (CORS) can cause this. The account is not verified; creating another registration will not fix this.',
      ),
      'OpenAI discovery failed',
      'temporarily-unavailable',
    );
    if (data.issuer !== AUTH_ORIGIN)
      throw chatgptError('sign-in-failed', 'OpenAI discovery issuer did not match.');
    return data;
  }
  async function identity(
    id: string,
    issuedId: string,
    nonce: string,
    signal: AbortSignal,
    refresh = false,
  ): Promise<{ subject: string; email?: string }> {
    // Network/discovery failures do not establish that an otherwise valid session is unusable.
    const discovery = await discover(signal);
    const jwks = await jsonSafe(
      await fetchSafe(
        fetch,
        authEndpoint(discovery.jwks_uri),
        { signal },
        'temporarily-unavailable',
        'The browser could not load OpenAI public signing keys. Check network access and browser restrictions (CORS). The account cannot be verified without these keys.',
      ),
      'OpenAI signing keys are unavailable',
      'temporarily-unavailable',
    );
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100)
      throw chatgptError(
        'temporarily-unavailable',
        'OpenAI signing keys are unavailable. Retry shortly.',
      );
    try {
      const { payload } = await jwtVerify(id, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: AUTH_ORIGIN,
        audience: issuedId,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
        currentDate: new Date(now()),
      });
      if (
        !bounded(payload.sub) ||
        (!refresh && payload.nonce !== nonce) ||
        (refresh && payload.nonce !== undefined && payload.nonce !== nonce) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== issuedId) ||
        (payload.azp !== undefined && payload.azp !== issuedId)
      )
        throw new Error('claims');
      const email = bounded(payload.email, 200) ? payload.email.replace(/\p{Cc}/gu, '') : undefined;
      return { subject: payload.sub, ...(email ? { email } : {}) };
    } catch {
      throw new ChatGPTBrowserError(
        'identity-verification-failed',
        'ChatGPT identity could not be verified. Start a fresh sign-in.',
        { invalidatesSession: true },
      );
    }
  }
  async function tokenRequest(
    form: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await fetchSafe(
      fetch,
      TOKEN_ENDPOINT,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
      },
      'temporarily-unavailable',
      'ChatGPT token exchange is unreachable. Check your connection and retry.',
    );
    if (response.ok)
      return jsonSafe(response, 'ChatGPT returned an invalid token response.', 'invalid-response');
    let code: ChatGPTBrowserTokenErrorCode | undefined;
    try {
      const error = await readJson(response, 'ChatGPT token exchange failed.', 16_384);
      const candidate = record(error.error) ? error.error.code : error.error;
      if (
        typeof candidate === 'string' &&
        (TERMINAL_REFRESH_CODES.has(candidate as ChatGPTBrowserTokenErrorCode) ||
          candidate === 'invalid_client')
      )
        code = candidate as ChatGPTBrowserTokenErrorCode;
    } catch {
      /* Non-JSON or oversized errors remain sanitized, unclassified failures. */
    }
    const terminal =
      (response.status === 400 || response.status === 401) &&
      code !== undefined &&
      code !== 'invalid_client';
    const configuration =
      code === 'invalid_client' && response.status < 500 && response.status !== 429;
    const message = terminal
      ? 'ChatGPT token exchange failed: this session is no longer usable. Sign in to the saved account again.'
      : configuration
        ? 'ChatGPT client registration was rejected. Check the client configuration before signing in again.'
        : 'ChatGPT token exchange temporarily failed. Your session is retained; retry shortly.';
    throw new ChatGPTBrowserError(
      terminal
        ? 'reauthentication-required'
        : configuration
          ? 'client-configuration'
          : 'temporarily-unavailable',
      `${message} (HTTP ${String(response.status)}).`,
      {
        status: response.status,
        invalidatesSession: terminal,
        ...(code === undefined ? {} : { tokenErrorCode: code }),
      },
    );
  }
  function tokens(data: Record<string, unknown>, previous?: Tokens): Tokens {
    if (
      !bounded(data.access_token, 32768) ||
      data.token_type !== 'Bearer' ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 365 * 86400 ||
      (data.refresh_token !== undefined && !bounded(data.refresh_token, 32768)) ||
      (data.id_token !== undefined && !bounded(data.id_token, 32768)) ||
      (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 4096))
    ) {
      throw chatgptError(
        'invalid-response',
        'ChatGPT returned an invalid token response. Sign in again.',
      );
    }
    const id = data.id_token ?? previous?.id;
    if (!bounded(id, 32768) || (previous === undefined && typeof data.scope !== 'string')) {
      throw chatgptError(
        'invalid-response',
        'ChatGPT did not return the required identity and granted scopes.',
      );
    }
    const refresh = data.refresh_token ?? previous?.refresh;
    return {
      access: data.access_token,
      id,
      expiresAt: now() + data.expires_in * 1000,
      scopes:
        typeof data.scope === 'string'
          ? data.scope.split(/\s+/).filter(Boolean)
          : (previous?.scopes ?? []),
      ...(typeof refresh === 'string' ? { refresh } : {}),
    };
  }

  function checkAttempt(pending: Attempt): void {
    if (
      disposed ||
      attempt !== pending ||
      pending.controller.signal.aborted ||
      now() >= pending.expiresAt
    ) {
      throw chatgptError('sign-in-cancelled', 'ChatGPT sign-in was cancelled or expired.');
    }
  }
  function checkSession(current: Session): void {
    if (disposed || session !== current || current.controller.signal.aborted)
      throw chatgptError('cancelled', 'ChatGPT session changed. Sign in and try again.');
  }
  function cancelSignIn(): void {
    attempt?.finish(chatgptError('sign-in-cancelled', 'ChatGPT sign-in cancelled.'));
  }

  async function callback(pending: Attempt, url: URL): Promise<void> {
    try {
      checkAttempt(pending);
      if (
        url.origin !== hostWindow?.location.origin ||
        url.pathname !== callbackPath ||
        url.hash ||
        url.username ||
        url.password ||
        ['state', 'code', 'client_id', 'error'].some(
          (key) => url.searchParams.getAll(key).length > 1,
        ) ||
        url.searchParams.get('state') !== pending.state
      )
        throw chatgptError(
          'sign-in-failed',
          'ChatGPT callback could not be verified. Start a fresh sign-in.',
        );
      if (url.searchParams.has('error'))
        throw chatgptError(
          'sign-in-cancelled',
          'ChatGPT sign-in was not authorized. Start a fresh sign-in when ready.',
        );
      const issued = url.searchParams.get('client_id') ?? pending.selected?.id;
      const code = url.searchParams.get('code');
      if (
        !clientId(issued) ||
        !bounded(code) ||
        (pending.selected !== undefined && issued !== pending.selected.id) ||
        (pending.selected === undefined && registrations.some((account) => account.id === issued))
      ) {
        throw chatgptError(
          'sign-in-failed',
          'ChatGPT returned a mismatched or incomplete client registration.',
        );
      }
      // Save the issued registration even if its short-lived code cannot be exchanged.
      // No identity is trusted until signature verification succeeds below.
      if (pending.selected === undefined) {
        if (registrations.length >= 100)
          throw chatgptError('sign-in-failed', 'Too many saved ChatGPT registrations.');
        registrations.push({
          id: issued,
          label: `Unverified ChatGPT registration ${String(registrations.length + 1)} (${issued})`,
        });
        persist();
        changed();
      }
      const data = await tokenRequest(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: issued,
          code,
          code_verifier: pending.verifier,
          redirect_uri: pending.redirect,
          resource: RESOURCE,
        }),
        pending.controller.signal,
      );
      checkAttempt(pending);
      const next = tokens(data);
      const verified = await identity(next.id, issued, pending.nonce, pending.controller.signal);
      checkAttempt(pending);
      if (
        pending.selected?.subject !== undefined &&
        pending.selected.subject !== verified.subject
      ) {
        throw chatgptError(
          'identity-verification-failed',
          'ChatGPT returned a different identity for the selected account.',
        );
      }
      const registration: Registration = {
        id: issued,
        subject: verified.subject,
        label: `${verified.email ?? 'ChatGPT account'} (${issued})`,
        ...(verified.email === undefined ? {} : { email: verified.email }),
      };
      registrations = registrations.map((item) => (item.id === issued ? registration : item));
      persist();
      session?.controller.abort();
      session = {
        registration,
        nonce: pending.nonce,
        tokens: next,
        controller: new AbortController(),
      };
      epoch += 1;
      notice = next.scopes.includes(PLAN_SCOPE) ? notices.ready : notices.planNotGranted;
      void saveStored(session);
      pending.finish();
    } catch (error) {
      pending.finish(
        error instanceof OpenAIResponsesModelError
          ? error
          : chatgptError('sign-in-failed', 'ChatGPT sign-in failed. Start a fresh sign-in.'),
      );
    }
  }
  function onMessage(event: MessageEvent<unknown>): void {
    const pending = attempt;
    if (
      pending === undefined ||
      !pending.ready ||
      pending.consumed ||
      event.source !== pending.popup ||
      event.origin !== hostWindow?.location.origin ||
      !record(event.data) ||
      event.data.type !== messageType
    )
      return;
    pending.consumed = true;
    try {
      if (!bounded(event.data.url, 16384)) throw new Error('invalid');
      void callback(pending, new URL(event.data.url));
    } catch {
      pending.finish(chatgptError('sign-in-failed', 'ChatGPT callback could not be verified.'));
    }
  }
  hostWindow?.addEventListener('message', onMessage);

  function signIn(accountId?: string): Promise<void> {
    const reason = disposed ? 'disposed' : support.reason;
    if (reason !== undefined || hostWindow === undefined)
      return Promise.reject(
        chatgptError('unsupported-environment', notices.unsupported(reason ?? 'no-window')),
      );
    const selected =
      accountId === undefined ? undefined : registrations.find((item) => item.id === accountId);
    if (accountId !== undefined && selected === undefined)
      return Promise.reject(
        chatgptError('sign-in-failed', 'Select a saved ChatGPT registration or add a new account.'),
      );
    // Retained in memory only; the documented hint skips the account selector.
    const idTokenHint =
      selected !== undefined && session?.registration.id === selected.id
        ? session.tokens.id
        : undefined;
    cancelSignIn();
    epoch += 1;
    // Must run before any await/crypto operation, in the original click's activation.
    let popup: Window | null;
    try {
      popup = hostWindow.open('about:blank', '_blank', 'popup,width=560,height=760');
    } catch {
      popup = null;
    }
    if (popup === null)
      return Promise.reject(
        chatgptError(
          'popup-blocked',
          'ChatGPT sign-in popup was blocked. Allow popups for this page and try again.',
        ),
      );
    const opened = popup;
    const origin = hostWindow.location.origin;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () =>
          pending.finish(
            chatgptError('sign-in-cancelled', 'ChatGPT sign-in timed out. Start a fresh sign-in.'),
          ),
        signInTimeout,
      );
      const poll = setInterval(() => {
        if (!pending.consumed && opened.closed)
          pending.finish(
            chatgptError('sign-in-cancelled', 'ChatGPT sign-in popup was closed. Try again.'),
          );
      }, 300);
      const pending: Attempt = {
        popup: opened,
        controller: new AbortController(),
        state: '',
        nonce: '',
        verifier: '',
        redirect: `${origin}${callbackPath}`,
        selected,
        expiresAt: now() + signInTimeout,
        ready: false,
        consumed: false,
        finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearInterval(poll);
          pending.controller.abort();
          pending.state = '';
          pending.nonce = '';
          pending.verifier = '';
          if (attempt === pending) attempt = undefined;
          try {
            opened.close();
          } catch {
            /* Cross-origin close can fail. */
          }
          changed();
          if (error === undefined) resolve();
          else reject(error);
        },
      };
      attempt = pending;
      changed();
      void (async () => {
        try {
          const hostId = host();
          pending.state = random();
          pending.nonce = random();
          pending.verifier = random();
          const digest = await globalThis.crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(pending.verifier),
          );
          checkAttempt(pending);
          const url = new URL(AUTHORIZE_ENDPOINT);
          url.search = new URLSearchParams({
            client_id: selected?.id ?? DYNAMIC_CLIENT_ID,
            ...(selected === undefined ? { agent_name_hint: appName } : {}),
            ...(idTokenHint === undefined ? {} : { id_token_hint: idTokenHint }),
            ...(idTokenHint === undefined && selected?.email !== undefined
              ? { login_hint: selected.email }
              : {}),
            ext_agent_host_id: hostId,
            response_type: 'code',
            redirect_uri: pending.redirect,
            scope: SCOPES,
            resource: RESOURCE,
            state: pending.state,
            nonce: pending.nonce,
            code_challenge_method: 'S256',
            code_challenge: base64url(new Uint8Array(digest)),
          }).toString();
          pending.ready = true;
          opened.location.replace(url.href);
        } catch (error) {
          pending.finish(
            error instanceof OpenAIResponsesModelError
              ? error
              : chatgptError('sign-in-failed', 'Could not prepare ChatGPT sign-in. Try again.'),
          );
        }
      })();
    });
  }

  function clearSession(current: Session): void {
    current.controller.abort();
    current.tokens = EMPTY_TOKENS();
    if (session === current) session = undefined;
  }

  async function ready(): Promise<Session> {
    const current = session;
    if (current === undefined)
      throw chatgptError('not-signed-in', 'Sign in with ChatGPT before requesting models.');
    checkSession(current);
    if (!current.tokens.scopes.includes(PLAN_SCOPE))
      throw chatgptError(
        'plan-not-granted',
        'This ChatGPT account has not granted plan usage. Reauthorize the saved account.',
      );
    if (
      current.tokens.expiresAt <= now() ||
      (current.tokens.refresh !== undefined && current.tokens.expiresAt - now() < 60_000)
    ) {
      if (current.refreshing === undefined) {
        const task = (async () => {
          const refresh = current.tokens.refresh;
          if (refresh === undefined)
            throw new ChatGPTBrowserError(
              'reauthentication-required',
              'ChatGPT session expired. Sign in to the saved account again.',
              { invalidatesSession: true },
            );
          const controller = new AbortController();
          const abort = () => controller.abort();
          current.controller.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, 30_000);
          try {
            const data = await tokenRequest(
              new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: current.registration.id,
                refresh_token: refresh,
                resource: RESOURCE,
              }),
              controller.signal,
            );
            const next = tokens(data, current.tokens);
            if (data.id_token !== undefined) {
              const verified = await identity(
                next.id,
                current.registration.id,
                current.nonce,
                controller.signal,
                true,
              );
              if (verified.subject !== current.registration.subject)
                throw new ChatGPTBrowserError(
                  'reauthentication-required',
                  'ChatGPT refresh returned a different account identity. Sign in again.',
                  { invalidatesSession: true },
                );
            }
            checkSession(current);
            // Replace access token, expiry, scopes, and rotating refresh token together.
            current.tokens = next;
            if (next.refresh !== refresh) void saveStored(current);
          } finally {
            clearTimeout(timer);
            current.controller.signal.removeEventListener('abort', abort);
          }
        })();
        current.refreshing = task;
        void task
          .finally(() => {
            delete current.refreshing;
          })
          .catch(() => undefined);
      }
      try {
        await current.refreshing;
      } catch (error) {
        if (session !== current)
          throw chatgptError(
            'cancelled',
            'ChatGPT session could not be refreshed because the session changed.',
          );
        if (error instanceof ChatGPTBrowserError && error.invalidatesSession) {
          clearSession(current);
          notice = notices.ready;
          changed();
          void clearStored();
        }
        if (error instanceof ChatGPTBrowserError) throw error;
        throw chatgptError(
          'temporarily-unavailable',
          'ChatGPT refresh temporarily failed. Your session is retained; retry shortly.',
        );
      }
    }
    checkSession(current);
    if (!current.tokens.scopes.includes(PLAN_SCOPE))
      throw chatgptError(
        'plan-not-granted',
        'ChatGPT plan usage is no longer granted for this account.',
      );
    return current;
  }
  function readyForRequest(cancellation?: CancellationSignal): Promise<Session> {
    cancellation?.throwIfCancelled();
    if (cancellation === undefined) return ready();
    return new Promise((resolve, reject) => {
      const unsubscribe = cancellation.onCancel(() => reject(new CancellationError()));
      void ready().then(resolve, reject).finally(unsubscribe);
    });
  }
  function requestLifetime(current: Session, cancellation?: CancellationSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    current.controller.signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = cancellation?.onCancel(abort);
    const timer = setTimeout(abort, requestTimeout);
    return {
      signal: controller.signal,
      check() {
        cancellation?.throwIfCancelled();
        checkSession(current);
        if (controller.signal.aborted)
          throw chatgptError('cancelled', 'ChatGPT request was cancelled or timed out.');
      },
      cleanup() {
        clearTimeout(timer);
        current.controller.signal.removeEventListener('abort', abort);
        unsubscribe?.();
        controller.abort();
      },
    };
  }
  async function signOut(): Promise<{ revoked: boolean }> {
    cancelSignIn();
    const version = ++epoch;
    const previous = session;
    const refreshWasInFlight = previous?.refreshing !== undefined;
    session = undefined;
    previous?.controller.abort();
    changed();
    // Queued now, so it runs after any save already in flight and before any later save.
    const cleared = clearStored();
    let revoked = previous === undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      if (previous !== undefined) {
        if (previous.tokens.refresh === undefined) throw new Error('no refresh token');
        const discovery = await discover(controller.signal);
        const endpoint = authEndpoint(discovery.revocation_endpoint);
        const response = await fetchSafe(
          fetch,
          endpoint,
          {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: previous.tokens.refresh,
              token_type_hint: 'refresh_token',
              client_id: previous.registration.id,
            }),
          },
          'temporarily-unavailable',
          'ChatGPT revocation could not be confirmed.',
        );
        revoked = response.status === 200 && !refreshWasInFlight;
        await discardBody(response);
      }
    } catch {
      revoked = false;
    } finally {
      clearTimeout(timeout);
      // A detached session may still be referenced by aborted requests: erase its tokens too.
      if (previous !== undefined) previous.tokens = EMPTY_TOKENS();
      await cleared;
      if (epoch === version && !disposed) {
        notice = revoked ? notices.ready : notices.revocationUnconfirmed;
        changed();
      }
    }
    return { revoked };
  }

  async function runRestore(
    store: ChatGPTBrowserSessionStore,
  ): Promise<ChatGPTBrowserRestoreResult> {
    const start = epoch;
    const current = () =>
      !disposed && epoch === start && session === undefined && attempt === undefined;
    let raw: unknown;
    try {
      raw = await store.load();
    } catch {
      return 'unavailable';
    }
    if (!current()) return 'superseded';
    if (raw === null || raw === undefined) return 'none';
    const saved = persistedSession(raw);
    const known = saved && registrations.find((item) => item.id === saved.clientId);
    if (saved === undefined || (known?.subject !== undefined && known.subject !== saved.subject)) {
      await clearStored();
      return 'discarded';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let data: Record<string, unknown>;
    try {
      data = await tokenRequest(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: saved.clientId,
          refresh_token: saved.refreshToken,
          resource: RESOURCE,
        }),
        controller.signal,
      );
    } catch (error) {
      clearTimeout(timer);
      if (!current()) return 'superseded';
      if (
        error instanceof ChatGPTBrowserError &&
        (error.invalidatesSession || error.kind === 'client-configuration')
      ) {
        await clearStored();
        return 'discarded';
      }
      return 'unavailable';
    }
    if (!current()) {
      clearTimeout(timer);
      return 'superseded';
    }
    // The stored refresh token may have rotated: keep the new one if verification is only delayed.
    const rotated = bounded(data.refresh_token, 32768) ? data.refresh_token : saved.refreshToken;
    let next: Tokens;
    let verified: { subject: string; email?: string };
    try {
      next = tokens(data, {
        ...EMPTY_TOKENS(),
        scopes: saved.scopes,
        refresh: saved.refreshToken,
      });
      // A restore always requires a freshly signed ID token for the stored subject.
      verified = await identity(next.id, saved.clientId, saved.nonce, controller.signal, true);
      if (verified.subject !== saved.subject)
        throw new ChatGPTBrowserError(
          'identity-verification-failed',
          'Stored ChatGPT session returned a different identity.',
          { invalidatesSession: true },
        );
    } catch (error) {
      if (!current()) return 'superseded';
      if (
        error instanceof ChatGPTBrowserError &&
        error.kind === 'temporarily-unavailable' &&
        !error.invalidatesSession
      ) {
        if (rotated !== saved.refreshToken)
          await enqueueStore(async (target) => {
            if (!current()) return false;
            await target.save({ ...saved, refreshToken: rotated, savedAt: now() });
            return true;
          });
        return 'unavailable';
      }
      await clearStored();
      return 'discarded';
    } finally {
      clearTimeout(timer);
    }
    if (!current()) return 'superseded';
    const email = verified.email ?? saved.email;
    const registration: Registration = {
      id: saved.clientId,
      subject: saved.subject,
      label: `${email ?? 'ChatGPT account'} (${saved.clientId})`,
      ...(email === undefined ? {} : { email }),
    };
    if (known !== undefined)
      registrations = registrations.map((item) =>
        item.id === saved.clientId ? registration : item,
      );
    else if (registrations.length < 100) registrations = [...registrations, registration];
    try {
      persist();
    } catch {
      /* Registration metadata is optional for a restored in-memory session. */
    }
    const restored: Session = {
      registration,
      nonce: saved.nonce,
      tokens: next,
      controller: new AbortController(),
    };
    session = restored;
    epoch += 1;
    notice = next.scopes.includes(PLAN_SCOPE) ? notices.ready : notices.planNotGranted;
    changed();
    await saveStored(restored);
    return 'restored';
  }
  function restoreSession(): Promise<ChatGPTBrowserRestoreResult> {
    if (sessionStore === undefined || disposed || support.reason !== undefined)
      return Promise.resolve('none');
    if (restoring !== undefined) return restoring;
    if (session !== undefined || attempt !== undefined) return Promise.resolve('superseded');
    const store = sessionStore;
    const task = (async (): Promise<ChatGPTBrowserRestoreResult> => {
      try {
        return await runRestore(store);
      } catch {
        return 'unavailable';
      } finally {
        restoring = undefined;
        changed();
      }
    })();
    restoring = task;
    changed();
    return task;
  }

  const transport: OpenAICompatibleResponsesTransport = Object.freeze({
    async send(request: OpenAIResponsesRequest) {
      request.signal?.throwIfCancelled();
      const body = shapeRequest(request.body, namespace);
      const current = await readyForRequest(request.signal);
      const lifetime = requestLifetime(current, request.signal);
      try {
        lifetime.check();
        const response = await fetchSafe(
          fetch,
          `${RESOURCE}/responses`,
          {
            method: 'POST',
            signal: lifetime.signal,
            headers: {
              Authorization: `Bearer ${current.tokens.access}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body,
          },
          'temporarily-unavailable',
          'ChatGPT inference is unreachable from this browser. No generation was retried.',
        );
        lifetime.check();
        if (!response.ok)
          throw await resourceFailure(
            response,
            'ChatGPT inference was rejected. No generation was retried',
          );
        // The provider streams plan responses without a Content-Type header; only a declared
        // non-stream type is rejected. The stream shaper validates every event regardless.
        const contentType = response.headers.get('content-type');
        if (
          response.body === null ||
          (contentType !== null && !contentType.includes('text/event-stream'))
        ) {
          await discardBody(response);
          throw chatgptError(
            'invalid-response',
            `ChatGPT inference did not return a stream (HTTP ${String(response.status)}). No generation was retried.`,
            { status: response.status },
          );
        }
        return {
          status: response.status,
          contentType: 'text/event-stream',
          body: shapeStream(
            response.body,
            namespace.name,
            () => lifetime.check(),
            () => lifetime.cleanup(),
          ),
        };
      } catch (error) {
        lifetime.cleanup();
        request.signal?.throwIfCancelled();
        throw error instanceof OpenAIResponsesModelError
          ? error
          : chatgptError('request-failed', 'ChatGPT inference failed. No generation was retried.');
      }
    },
  });

  return Object.freeze({
    getStatus,
    subscribe(listener: (status: ChatGPTBrowserStatus) => void) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signIn,
    signOut,
    cancelSignIn,
    restoreSession,
    saveSession() {
      return session === undefined ? Promise.resolve(false) : saveStored(session);
    },
    forgetStoredSession: clearStored,
    transport,
    async listModels() {
      const current = await ready();
      const lifetime = requestLifetime(current);
      try {
        lifetime.check();
        const response = await fetchSafe(
          fetch,
          `${RESOURCE}/models`,
          {
            signal: lifetime.signal,
            headers: {
              Authorization: `Bearer ${current.tokens.access}`,
              Accept: 'application/json',
            },
          },
          'temporarily-unavailable',
          'ChatGPT models are unreachable from this browser.',
        );
        if (!response.ok)
          throw await resourceFailure(
            response,
            'ChatGPT models could not be loaded for this account',
          );
        const data = await readJson(response, 'ChatGPT returned an invalid model catalog.');
        lifetime.check();
        if (!Array.isArray(data.models) || data.models.length > 1000)
          throw chatgptError('invalid-response', 'ChatGPT returned an invalid model catalog.');
        const seen = new Set<string>();
        // Keep the server's order; show display_name and send slug as the model.
        return Object.freeze(
          data.models.flatMap((item) => {
            if (
              !record(item) ||
              item.visibility !== 'list' ||
              !bounded(item.slug, 200) ||
              !bounded(item.display_name, 200) ||
              seen.has(item.slug)
            )
              return [];
            seen.add(item.slug);
            return [Object.freeze({ slug: item.slug, displayName: item.display_name })];
          }),
        );
      } finally {
        lifetime.cleanup();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      cancelSignIn();
      if (session !== undefined) clearSession(session);
      session = undefined;
      hostWindow?.removeEventListener('message', onMessage);
      changed();
      listeners.clear();
    },
  });
}
