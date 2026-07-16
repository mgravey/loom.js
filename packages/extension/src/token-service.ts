import { isCredentialProviderError } from '@loom/credential-provider-api';

import type {
  AccessTokenResult,
  BrokerClock,
  CachedAccessToken,
  ExtensionCredentialProvider,
  RefreshCredentialStore,
} from './contracts.js';
import { ExtensionBrokerError } from './contracts.js';

export interface CreateExtensionTokenServiceOptions {
  readonly providers: readonly ExtensionCredentialProvider[];
  readonly credentialStore: RefreshCredentialStore;
  readonly clock?: BrokerClock;
  readonly expirationSkewMs?: number;
}

export interface ExtensionTokenService {
  getAccessToken(providerId: string): Promise<CachedAccessToken>;
  getStatus(providerId: string): Promise<{ readonly authenticated: boolean }>;
  logout(providerId: string): Promise<void>;
  acceptAuthorizationResult(
    providerId: string,
    result: AccessTokenResult,
  ): Promise<CachedAccessToken>;
  clearCachedAccessToken(providerId: string): void;
}

const systemClock: BrokerClock = Object.freeze({ now: Date.now });

function assertProvider(provider: ExtensionCredentialProvider): void {
  if (provider.id.length === 0 || typeof provider.refresh !== 'function') {
    throw new TypeError('Credential providers require a non-empty ID and refresh function.');
  }
}

export function createExtensionTokenService(
  options: CreateExtensionTokenServiceOptions,
): ExtensionTokenService {
  const clock = options.clock ?? systemClock;
  const expirationSkewMs = options.expirationSkewMs ?? 30_000;
  if (!Number.isFinite(expirationSkewMs) || expirationSkewMs < 0) {
    throw new RangeError('The expiration skew must be a non-negative finite number.');
  }

  const providers = new Map<string, ExtensionCredentialProvider>();
  for (const provider of options.providers) {
    assertProvider(provider);
    if (providers.has(provider.id)) {
      throw new ExtensionBrokerError(
        'INTERNAL_ERROR',
        `Duplicate credential provider "${provider.id}".`,
      );
    }
    providers.set(provider.id, provider);
  }

  const cache = new Map<string, CachedAccessToken>();
  const pending = new Map<string, Promise<CachedAccessToken>>();

  async function persistAndCache(
    providerId: string,
    untrustedResult: unknown,
  ): Promise<CachedAccessToken> {
    if (typeof untrustedResult !== 'object' || untrustedResult === null) {
      throw new ExtensionBrokerError(
        'REFRESH_FAILED',
        `Provider "${providerId}" returned an invalid access token.`,
      );
    }
    const result = untrustedResult as Partial<AccessTokenResult>;
    if (
      typeof result.accessToken !== 'string' ||
      result.accessToken.length === 0 ||
      typeof result.expiresAt !== 'number' ||
      !Number.isFinite(result.expiresAt) ||
      result.expiresAt <= clock.now()
    ) {
      throw new ExtensionBrokerError(
        'REFRESH_FAILED',
        `Provider "${providerId}" returned an invalid access token.`,
      );
    }
    if (
      result.nextRefreshCredential !== undefined &&
      (typeof result.nextRefreshCredential.value !== 'string' ||
        result.nextRefreshCredential.value.length === 0)
    ) {
      throw new ExtensionBrokerError(
        'REFRESH_FAILED',
        `Provider "${providerId}" returned an invalid refresh credential.`,
      );
    }

    if (result.nextRefreshCredential !== undefined) {
      await options.credentialStore.set(providerId, result.nextRefreshCredential);
    }
    const token = Object.freeze({
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
    });
    cache.set(providerId, token);
    return token;
  }

  async function refresh(provider: ExtensionCredentialProvider): Promise<CachedAccessToken> {
    const credential = await options.credentialStore.get(provider.id);
    if (credential === undefined) {
      throw new ExtensionBrokerError(
        'MISSING_CREDENTIAL',
        `No refresh credential is available for provider "${provider.id}".`,
      );
    }

    let result: AccessTokenResult;
    try {
      result = await provider.refresh(credential);
    } catch (cause) {
      if (isCredentialProviderError(cause) && cause.code === 'CREDENTIAL_REJECTED') {
        cache.delete(provider.id);
        try {
          await options.credentialStore.delete(provider.id);
        } catch (deleteCause) {
          throw new ExtensionBrokerError(
            'INTERNAL_ERROR',
            `Rejected credential cleanup failed for provider "${provider.id}".`,
            { cause: deleteCause },
          );
        }
        throw new ExtensionBrokerError(
          'MISSING_CREDENTIAL',
          `The stored credential was rejected for provider "${provider.id}".`,
          { cause },
        );
      }
      throw new ExtensionBrokerError(
        'REFRESH_FAILED',
        `Access-token refresh failed for provider "${provider.id}".`,
        { cause },
      );
    }
    return persistAndCache(provider.id, result);
  }

  return Object.freeze({
    async getAccessToken(providerId: string) {
      const provider = providers.get(providerId);
      if (provider === undefined) {
        throw new ExtensionBrokerError(
          'UNKNOWN_PROVIDER',
          `Unknown credential provider "${providerId}".`,
        );
      }

      const cached = cache.get(providerId);
      if (cached !== undefined && cached.expiresAt - expirationSkewMs > clock.now()) {
        return cached;
      }

      const existing = pending.get(providerId);
      if (existing !== undefined) return existing;

      const operation = refresh(provider);
      pending.set(providerId, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(providerId) === operation) pending.delete(providerId);
      }
    },
    async acceptAuthorizationResult(providerId: string, result: AccessTokenResult) {
      if (!providers.has(providerId)) {
        throw new ExtensionBrokerError(
          'UNKNOWN_PROVIDER',
          `Unknown credential provider "${providerId}".`,
        );
      }

      const existing = pending.get(providerId);
      if (existing !== undefined) {
        try {
          await existing;
        } catch {
          // A newly authorized credential supersedes an in-flight refresh failure.
        }
      }

      const operation = persistAndCache(providerId, result);
      pending.set(providerId, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(providerId) === operation) pending.delete(providerId);
      }
    },
    clearCachedAccessToken(providerId: string) {
      cache.delete(providerId);
    },
    async getStatus(providerId: string) {
      if (!providers.has(providerId)) {
        throw new ExtensionBrokerError(
          'UNKNOWN_PROVIDER',
          `Unknown credential provider "${providerId}".`,
        );
      }
      const authenticated =
        cache.has(providerId) || (await options.credentialStore.get(providerId)) !== undefined;
      return Object.freeze({ authenticated });
    },
    async logout(providerId: string) {
      if (!providers.has(providerId)) {
        throw new ExtensionBrokerError(
          'UNKNOWN_PROVIDER',
          `Unknown credential provider "${providerId}".`,
        );
      }

      const existing = pending.get(providerId);
      if (existing !== undefined) {
        try {
          await existing;
        } catch {
          // Logout still clears any credential left behind by a failed operation.
        }
      }
      cache.delete(providerId);
      try {
        await options.credentialStore.delete(providerId);
      } catch (cause) {
        throw new ExtensionBrokerError(
          'INTERNAL_ERROR',
          `Credential cleanup failed for provider "${providerId}".`,
          { cause },
        );
      }
    },
  });
}
