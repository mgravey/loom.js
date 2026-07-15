import type {
  AuthorizationTransaction,
  AuthorizationTransactionStore,
  OAuthBrowserRedirect,
  OAuthDelay,
  OAuthHttpRequest,
  OAuthHttpTransport,
  SecureRandomSource,
  Sha256Digest,
} from '@loom/auth-codex-experimental';
import type { ChromeStorageArea } from '@loom/extension';

import type { BrowserCrypto, ChromeIdentityApi, OAuthFetch } from './chrome-contracts.js';

const TRANSACTION_PREFIX = 'loom.codex-experimental.transaction.';

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') {
    throw new TypeError('OAuth transport origin must be an exact HTTPS origin.');
  }
  return url.origin;
}

export function createFetchOAuthTransport(
  fetchRequest: OAuthFetch,
  allowedOrigin = 'https://auth.openai.com',
): OAuthHttpTransport {
  const origin = normalizedOrigin(allowedOrigin);
  return Object.freeze({
    async send(request: OAuthHttpRequest) {
      const url = new URL(request.url);
      if (url.origin !== origin || url.username.length > 0 || url.password.length > 0) {
        throw new TypeError('OAuth request target is outside the configured authorization origin.');
      }
      const response = await fetchRequest(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      return Object.freeze({ status: response.status, body: await response.text() });
    },
  });
}

export function createWebCryptoSha256Digest(cryptoApi: BrowserCrypto): Sha256Digest {
  return Object.freeze({
    async digest(input: Uint8Array) {
      const result = await cryptoApi.subtle.digest('SHA-256', new Uint8Array(input));
      return new Uint8Array(result);
    },
  });
}

export function createWebCryptoRandomSource(cryptoApi: BrowserCrypto): SecureRandomSource {
  return Object.freeze({
    randomBytes(length: number) {
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new RangeError('Random byte length must be a positive safe integer.');
      }
      return cryptoApi.getRandomValues(new Uint8Array(length));
    },
  });
}

export function createBrowserDelay(
  schedule: (callback: () => void, milliseconds: number) => unknown,
): OAuthDelay {
  return Object.freeze({
    wait(milliseconds: number) {
      return new Promise<void>((resolve) => {
        schedule(() => resolve(), milliseconds);
      });
    },
  });
}

export interface ChromeIdentityRedirectOptions {
  readonly redirectRegistrationApproved: boolean;
  readonly callbackPath?: string;
}

export function createChromeIdentityRedirect(
  identity: ChromeIdentityApi,
  options: ChromeIdentityRedirectOptions,
): OAuthBrowserRedirect {
  if (!options.redirectRegistrationApproved) {
    throw new TypeError('Direct browser authorization requires approved redirect registration.');
  }
  const redirectUri = identity.getRedirectURL(options.callbackPath ?? 'codex-auth');
  return Object.freeze({
    getRedirectUri: () => redirectUri,
    async launchAuthorization(url: string) {
      const callback = await identity.launchWebAuthFlow({ url, interactive: true });
      if (callback === undefined || callback.length === 0) {
        throw new Error('Chrome identity authorization did not return a callback URI.');
      }
      return callback;
    },
  });
}

function transactionKey(providerId: string): string {
  return `${TRANSACTION_PREFIX}${encodeURIComponent(providerId)}`;
}

function parseTransaction(value: unknown): AuthorizationTransaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AuthorizationTransaction>;
  if (
    typeof candidate.providerId !== 'string' ||
    typeof candidate.state !== 'string' ||
    typeof candidate.verifier !== 'string' ||
    typeof candidate.redirectUri !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: candidate.providerId,
    state: candidate.state,
    verifier: candidate.verifier,
    redirectUri: candidate.redirectUri,
    createdAt: candidate.createdAt,
  });
}

export function createChromeSessionAuthorizationTransactionStore(
  storage: ChromeStorageArea,
  redirectRegistrationApproved: boolean,
): AuthorizationTransactionStore {
  if (!redirectRegistrationApproved) {
    throw new TypeError('Direct browser authorization transaction storage is disabled.');
  }
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return Object.freeze({
    async put(transaction: AuthorizationTransaction) {
      await ready;
      await storage.set({ [transactionKey(transaction.providerId)]: transaction });
    },
    async take(providerId: string) {
      await ready;
      const key = transactionKey(providerId);
      const result = await storage.get(key);
      await storage.remove(key);
      return parseTransaction(result[key]);
    },
    async delete(providerId: string) {
      await ready;
      await storage.remove(transactionKey(providerId));
    },
  });
}
