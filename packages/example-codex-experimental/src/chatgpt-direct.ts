import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { CancellationError, type CancellationSignal } from '@mgravey/loom-types';
import {
  OpenAIResponsesModelError,
  type OpenAICompatibleResponsesTransport,
  type OpenAIResponsesRequest,
} from '@mgravey/loom-model-openai-responses';
import {
  ChatGPTDirectError,
  directError,
  directRequest,
  directStream,
  record,
  type ChatGPTDirectTokenErrorCode,
} from './chatgpt-direct-stream.js';
export { ChatGPTDirectError } from './chatgpt-direct-stream.js';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const DISCOVERY = `${AUTH}/.well-known/openid-configuration`;
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const HOST_KEY = 'loom.chatgpt-direct.host.v1';
const ACCOUNTS_KEY = 'loom.chatgpt-direct.registrations.v1';
const CALLBACK_TYPE = 'loom/chatgpt-direct/callback';
const ATTEMPT_MS = 5 * 60 * 1000;
const LOCAL_URL =
  'http://127.0.0.1:4174/example-codex-experimental/workbench.html?provider=chatgpt-direct';
const PROTOTYPE = 'Local browser sign-in is experimental.';

export interface ChatGPTDirectStatus {
  readonly supported: boolean;
  readonly authenticated: boolean;
  readonly planEnabled: boolean;
  readonly accountLabel?: string;
  readonly activeAccountId?: string;
  readonly accounts: readonly { readonly id: string; readonly label: string }[];
  readonly notice?: string;
}

export interface ChatGPTDirectClient {
  getStatus(): ChatGPTDirectStatus;
  signIn(accountId?: string): Promise<void>;
  signOut(): Promise<{ revoked: boolean }>;
  cancelSignIn(): void;
  listModels(): Promise<readonly { slug: string; displayName: string }[]>;
  readonly transport: OpenAICompatibleResponsesTransport;
  dispose(): void;
}

interface Registration {
  id: string;
  label: string;
  subject?: string;
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

function bounded(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
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
    throw directError('OpenAI discovery did not provide a valid endpoint.');
  const url = new URL(value);
  if (url.origin !== AUTH || url.username || url.password || url.hash || url.search) {
    throw directError('OpenAI discovery returned an untrusted endpoint.');
  }
  return url.href;
}

/** No provider bodies, OAuth codes, URLs, or underlying exceptions escape this module. */
async function fetchSafe(url: string, init: RequestInit, message: string): Promise<Response> {
  try {
    return await globalThis.fetch(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw directError(message);
  }
}
async function jsonSafe(response: Response, message: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* No error body is read. */
    }
    throw directError(`${message} (HTTP ${String(response.status)}).`);
  }
  return readJson(response, message);
}
async function readJson(
  response: Response,
  message: string,
  maximum = 1024 * 1024,
): Promise<Record<string, unknown>> {
  // Bound untrusted JSON before parsing, including discovery and model catalogs.
  const reader = response.body?.getReader();
  if (reader === undefined) throw directError(message);
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.length > maximum) throw directError(message);
      if (chunk.done) break;
    }
    const value: unknown = JSON.parse(text);
    if (!record(value)) throw directError(message);
    return value;
  } catch {
    throw directError(message);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* No provider errors escape. */
    }
    reader.releaseLock();
  }
}
async function discover(signal: AbortSignal): Promise<Record<string, unknown>> {
  const data = await jsonSafe(
    await fetchSafe(
      DISCOVERY,
      { signal },
      'The browser could not load OpenAI sign-in configuration. Network or browser access restrictions (CORS) can cause this. The account is not verified; creating another registration will not fix this.',
    ),
    'OpenAI discovery failed',
  );
  if (data.issuer !== AUTH) throw directError('OpenAI discovery issuer did not match.');
  return data;
}
async function identity(
  id: string,
  issuedId: string,
  nonce: string,
  signal: AbortSignal,
  refresh = false,
): Promise<{ subject: string; label?: string }> {
  // Network/discovery failures do not establish that an otherwise valid session is unusable.
  const discovery = await discover(signal);
  const jwks = await jsonSafe(
    await fetchSafe(
      authEndpoint(discovery.jwks_uri),
      { signal },
      'The browser could not load OpenAI public signing keys. Check network access and browser restrictions (CORS). The account cannot be verified without these keys.',
    ),
    'OpenAI signing keys are unavailable',
  );
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 100)
    throw directError('OpenAI signing keys are unavailable. Retry shortly.');
  try {
    const { payload } = await jwtVerify(id, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
      issuer: AUTH,
      audience: issuedId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
    if (
      !bounded(payload.sub) ||
      (!refresh && payload.nonce !== nonce) ||
      (refresh && payload.nonce !== undefined && payload.nonce !== nonce) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== issuedId) ||
      (payload.azp !== undefined && payload.azp !== issuedId)
    )
      throw new Error();
    return {
      subject: payload.sub,
      ...(bounded(payload.email, 200)
        ? {
            label: payload.email.replace(/\p{Cc}/gu, ''),
          }
        : {}),
    };
  } catch {
    throw new ChatGPTDirectError('ChatGPT identity could not be verified. Start a fresh sign-in.', {
      invalidatesSession: true,
    });
  }
}
async function tokenRequest(
  form: URLSearchParams,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchSafe(
    TOKEN,
    {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
    },
    'ChatGPT token exchange is unreachable. Check your connection and retry.',
  );
  if (response.ok) return jsonSafe(response, 'ChatGPT returned an invalid token response.');
  const allowlisted = new Set<ChatGPTDirectTokenErrorCode>([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
    'invalid_client',
  ]);
  let code: ChatGPTDirectTokenErrorCode | undefined;
  try {
    const error = await readJson(response, 'ChatGPT token exchange failed.', 16_384);
    const candidate = record(error.error) ? error.error.code : error.error;
    if (typeof candidate === 'string' && allowlisted.has(candidate as ChatGPTDirectTokenErrorCode))
      code = candidate as ChatGPTDirectTokenErrorCode;
  } catch {
    /* Non-JSON or oversized errors remain sanitized, unclassified failures. */
  }
  const terminal =
    (response.status === 400 || response.status === 401) &&
    code !== undefined &&
    code !== 'invalid_client';
  const message = terminal
    ? 'ChatGPT token exchange failed: this session is no longer usable. Sign in to the saved account again.'
    : code === 'invalid_client' && response.status < 500 && response.status !== 429
      ? 'ChatGPT client registration was rejected. Check the client configuration before signing in again.'
      : 'ChatGPT token exchange temporarily failed. Your session is retained; retry shortly.';
  throw new ChatGPTDirectError(`${message} (HTTP ${String(response.status)}).`, {
    status: response.status,
    invalidatesSession: terminal,
    ...(code === undefined ? {} : { tokenErrorCode: code }),
  });
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
    throw directError('ChatGPT returned an invalid token response. Sign in again.');
  }
  const id = data.id_token ?? previous?.id;
  if (!bounded(id, 32768) || (previous === undefined && typeof data.scope !== 'string')) {
    throw directError('ChatGPT did not return the required identity and granted scopes.');
  }
  const refresh = data.refresh_token ?? previous?.refresh;
  return {
    access: data.access_token,
    id,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes:
      typeof data.scope === 'string'
        ? data.scope.split(/\s+/).filter(Boolean)
        : (previous?.scopes ?? []),
    ...(typeof refresh === 'string' ? { refresh } : {}),
  };
}

export function createChatGPTDirectClient(): ChatGPTDirectClient {
  const environment = globalThis as { readonly window?: Window; readonly crypto?: Crypto };
  const supported =
    environment.window?.location.protocol === 'http:' &&
    environment.window.location.hostname === '127.0.0.1' &&
    typeof environment.crypto?.subtle.digest === 'function';
  let disposed = false;
  let session: Session | undefined;
  let attempt: Attempt | undefined;
  let notice = PROTOTYPE;
  let epoch = 0;
  let registrations: Registration[] = [];
  try {
    const raw: unknown = JSON.parse(globalThis.window.localStorage.getItem(ACCOUNTS_KEY) ?? '[]');
    if (Array.isArray(raw) && raw.length <= 100) {
      const seen = new Set<string>();
      registrations = raw.flatMap((item) => {
        if (
          !record(item) ||
          !clientId(item.id) ||
          !bounded(item.label, 500) ||
          seen.has(item.id) ||
          (item.subject !== undefined && !bounded(item.subject))
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
          },
        ];
      });
    }
  } catch {
    /* Storage can be unavailable; session credentials never use it. */
  }

  function persist(): void {
    // Enumerate allowed fields explicitly: never serialize a session or token response.
    try {
      globalThis.window.localStorage.setItem(
        ACCOUNTS_KEY,
        JSON.stringify(
          registrations.map(({ id, label, subject }) => ({
            id,
            label,
            ...(subject === undefined ? {} : { subject }),
          })),
        ),
      );
    } catch {
      throw directError(
        'Browser storage is unavailable. Allow local registration storage and sign in again.',
      );
    }
  }
  function host(): string {
    try {
      const saved = globalThis.window.localStorage.getItem(HOST_KEY);
      if (
        saved !== null &&
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          saved,
        )
      )
        return saved;
      const id = `urn:uuid:${globalThis.crypto.randomUUID()}`;
      globalThis.window.localStorage.setItem(HOST_KEY, id);
      return id;
    } catch {
      throw directError(
        'Browser storage is unavailable. Allow local host registration storage and sign in again.',
      );
    }
  }
  function checkAttempt(pending: Attempt): void {
    if (
      disposed ||
      attempt !== pending ||
      pending.controller.signal.aborted ||
      Date.now() >= pending.expiresAt
    ) {
      throw directError('ChatGPT sign-in was cancelled or expired.');
    }
  }
  function checkSession(current: Session): void {
    if (disposed || session !== current || current.controller.signal.aborted)
      throw directError('ChatGPT session changed. Sign in and try again.');
  }
  function cancelSignIn(): void {
    attempt?.finish(directError('ChatGPT sign-in cancelled.'));
  }

  async function callback(pending: Attempt, url: URL): Promise<void> {
    try {
      checkAttempt(pending);
      if (
        url.origin !== globalThis.window.location.origin ||
        url.pathname !== '/auth/callback' ||
        url.hash ||
        url.username ||
        url.password ||
        ['state', 'code', 'client_id', 'error'].some(
          (key) => url.searchParams.getAll(key).length > 1,
        ) ||
        url.searchParams.get('state') !== pending.state
      )
        throw directError('ChatGPT callback could not be verified. Start a fresh sign-in.');
      if (url.searchParams.has('error'))
        throw directError('ChatGPT sign-in was not authorized. Start a fresh sign-in when ready.');
      const issued = url.searchParams.get('client_id') ?? pending.selected?.id;
      const code = url.searchParams.get('code');
      if (
        !clientId(issued) ||
        !bounded(code) ||
        (pending.selected !== undefined && issued !== pending.selected.id) ||
        (pending.selected === undefined && registrations.some((account) => account.id === issued))
      ) {
        throw directError('ChatGPT returned a mismatched or incomplete client registration.');
      }
      // Save the issued registration even if its short-lived code cannot be exchanged.
      // No identity is trusted until signature verification succeeds below.
      if (pending.selected === undefined) {
        if (registrations.length >= 100) throw directError('Too many saved ChatGPT registrations.');
        registrations.push({
          id: issued,
          label: `Unverified ChatGPT registration ${String(registrations.length + 1)} (${issued})`,
        });
        persist();
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
        throw directError('ChatGPT returned a different identity for the selected account.');
      }
      const registration: Registration = {
        id: issued,
        subject: verified.subject,
        label: `${verified.label ?? 'ChatGPT account'} (${issued})`,
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
      notice = next.scopes.includes(PLAN_SCOPE)
        ? PROTOTYPE
        : 'Signed in, but ChatGPT plan usage was not granted. Reauthorize this saved account to enable models.';
      pending.finish();
    } catch (error) {
      pending.finish(
        error instanceof OpenAIResponsesModelError
          ? error
          : directError('ChatGPT sign-in failed. Start a fresh sign-in.'),
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
      event.origin !== globalThis.window.location.origin ||
      !record(event.data) ||
      event.data.type !== CALLBACK_TYPE
    )
      return;
    pending.consumed = true;
    try {
      if (!bounded(event.data.url, 16384)) throw new Error();
      void callback(pending, new URL(event.data.url));
    } catch {
      pending.finish(directError('ChatGPT callback could not be verified.'));
    }
  }
  if (typeof globalThis.window !== 'undefined')
    globalThis.window.addEventListener('message', onMessage);

  function signIn(accountId?: string): Promise<void> {
    if (disposed || !supported)
      return Promise.reject(
        directError(`Open the local test at ${LOCAL_URL}. This prototype requires HTTP 127.0.0.1.`),
      );
    const selected =
      accountId === undefined ? undefined : registrations.find((item) => item.id === accountId);
    const requestConsent =
      selected !== undefined &&
      session?.registration.id === selected.id &&
      !session.tokens.scopes.includes(PLAN_SCOPE);
    if (accountId !== undefined && selected === undefined)
      return Promise.reject(
        directError('Select a saved ChatGPT registration or add a new account.'),
      );
    cancelSignIn();
    epoch += 1;
    // Must run before any await/globalThis.crypto operation, in the original click's activation.
    let popup: Window | null;
    try {
      popup = globalThis.window.open('about:blank', '_blank', 'popup,width=560,height=760');
    } catch {
      popup = null;
    }
    if (popup === null)
      return Promise.reject(
        directError(
          'ChatGPT sign-in popup was blocked. Allow popups for this local page and try again.',
        ),
      );
    const opened = popup;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => pending.finish(directError('ChatGPT sign-in timed out. Start a fresh sign-in.')),
        ATTEMPT_MS,
      );
      const poll = setInterval(() => {
        if (!pending.consumed && opened.closed)
          pending.finish(directError('ChatGPT sign-in popup was closed. Try again.'));
      }, 300);
      const pending: Attempt = {
        popup: opened,
        controller: new AbortController(),
        state: '',
        nonce: '',
        verifier: '',
        redirect: `${globalThis.window.location.origin}/auth/callback`,
        selected,
        expiresAt: Date.now() + ATTEMPT_MS,
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
          if (error === undefined) resolve();
          else reject(error);
        },
      };
      attempt = pending;
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
          const url = new URL(`${AUTH}/api/accounts/authorize`);
          url.search = new URLSearchParams({
            client_id: selected?.id ?? 'dynamic_agent_client',
            ...(selected === undefined ? { agent_name_hint: 'Loom.js' } : {}),
            ...(requestConsent ? { prompt: 'consent' } : {}),
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
              : directError('Could not prepare ChatGPT sign-in. Try again.'),
          );
        }
      })();
    });
  }

  async function ready(): Promise<Session> {
    const current = session;
    if (current === undefined) throw directError('Sign in with ChatGPT before requesting models.');
    checkSession(current);
    if (!current.tokens.scopes.includes(PLAN_SCOPE))
      throw directError(
        'This ChatGPT account has not granted plan usage. Reauthorize the saved account.',
      );
    if (
      current.tokens.expiresAt <= Date.now() ||
      (current.tokens.refresh !== undefined && current.tokens.expiresAt - Date.now() < 60_000)
    ) {
      if (current.refreshing === undefined) {
        const task = (async () => {
          const refresh = current.tokens.refresh;
          if (refresh === undefined)
            throw new ChatGPTDirectError(
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
                throw new ChatGPTDirectError(
                  'ChatGPT refresh returned a different account identity. Sign in again.',
                  { invalidatesSession: true },
                );
            }
            checkSession(current);
            current.tokens = next;
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
          throw directError('ChatGPT session could not be refreshed because the session changed.');
        if (error instanceof ChatGPTDirectError && error.invalidatesSession) {
          current.controller.abort();
          current.tokens = { access: '', id: '', expiresAt: 0, scopes: [] };
          session = undefined;
        }
        if (error instanceof ChatGPTDirectError) throw error;
        throw directError(
          'ChatGPT refresh temporarily failed. Your session is retained; retry shortly.',
        );
      }
    }
    checkSession(current);
    if (!current.tokens.scopes.includes(PLAN_SCOPE))
      throw directError('ChatGPT plan usage is no longer granted for this account.');
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
    const timer = setTimeout(abort, 120_000);
    return {
      signal: controller.signal,
      check() {
        cancellation?.throwIfCancelled();
        checkSession(current);
        if (controller.signal.aborted)
          throw directError('ChatGPT request was cancelled or timed out.');
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
    let revoked = previous === undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      if (previous !== undefined) {
        if (previous.tokens.refresh === undefined) throw new Error();
        const discovery = await discover(controller.signal);
        const endpoint = authEndpoint(discovery.revocation_endpoint);
        const response = await fetchSafe(
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
          'ChatGPT revocation could not be confirmed.',
        );
        revoked = response.status === 200 && !refreshWasInFlight;
        try {
          await response.body?.cancel();
        } catch {
          /* No revocation body is exposed. */
        }
      }
    } catch {
      revoked = false;
    } finally {
      clearTimeout(timeout);
      // Detached session may still be referenced by aborted requests: erase its token fields too.
      if (previous !== undefined)
        previous.tokens = { access: '', id: '', expiresAt: 0, scopes: [] };
      if (epoch === version && !disposed)
        notice = revoked
          ? PROTOTYPE
          : 'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.';
    }
    return { revoked };
  }

  const transport: OpenAICompatibleResponsesTransport = Object.freeze({
    async send(request: OpenAIResponsesRequest) {
      request.signal?.throwIfCancelled();
      const body = directRequest(request.body);
      const current = await readyForRequest(request.signal);
      const lifetime = requestLifetime(current, request.signal);
      try {
        lifetime.check();
        const response = await fetchSafe(
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
          'ChatGPT inference is unreachable from this browser. Authenticated CORS support is unverified.',
        );
        lifetime.check();
        if (
          !response.ok ||
          response.body === null ||
          !response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          try {
            await response.body?.cancel();
          } catch {
            /* Never expose response bodies. */
          }
          throw directError(
            `ChatGPT inference was rejected or did not return a stream (HTTP ${String(response.status)}). No generation was retried.`,
          );
        }
        return {
          status: response.status,
          contentType: 'text/event-stream',
          body: directStream(
            response.body,
            () => lifetime.check(),
            () => lifetime.cleanup(),
          ),
        };
      } catch (error) {
        lifetime.cleanup();
        request.signal?.throwIfCancelled();
        throw error instanceof OpenAIResponsesModelError
          ? error
          : directError('ChatGPT inference failed. No generation was retried.');
      }
    },
  });

  return Object.freeze({
    getStatus(): ChatGPTDirectStatus {
      return Object.freeze({
        supported: supported && !disposed,
        authenticated: session !== undefined,
        planEnabled: session?.tokens.scopes.includes(PLAN_SCOPE) ?? false,
        ...(session === undefined
          ? {}
          : { accountLabel: session.registration.label, activeAccountId: session.registration.id }),
        accounts: Object.freeze(registrations.map(({ id, label }) => Object.freeze({ id, label }))),
        notice: supported
          ? notice
          : `Local test only. Open ${LOCAL_URL}. Public/static hosting does not enable browser OAuth support.`,
      });
    },
    signIn,
    signOut,
    cancelSignIn,
    transport,
    async listModels() {
      const current = await ready();
      const lifetime = requestLifetime(current);
      try {
        lifetime.check();
        const data = await jsonSafe(
          await fetchSafe(
            `${RESOURCE}/models`,
            {
              signal: lifetime.signal,
              headers: {
                Authorization: `Bearer ${current.tokens.access}`,
                Accept: 'application/json',
              },
            },
            'ChatGPT models are unreachable from this browser. Authenticated CORS support is unverified.',
          ),
          'ChatGPT models could not be loaded for this account',
        );
        lifetime.check();
        if (!Array.isArray(data.models) || data.models.length > 1000)
          throw directError('ChatGPT returned an invalid model catalog.');
        const seen = new Set<string>();
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
      session?.controller.abort();
      if (session !== undefined) session.tokens = { access: '', id: '', expiresAt: 0, scopes: [] };
      session = undefined;
      if (typeof globalThis.window !== 'undefined')
        globalThis.window.removeEventListener('message', onMessage);
    },
  });
}
