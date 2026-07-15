import type { CredentialProvider, StoredRefreshCredential } from '@loom/credential-provider-api';

export { CredentialProviderError, isCredentialProviderError } from '@loom/credential-provider-api';
export type {
  AccessTokenResult,
  CredentialProvider,
  CredentialProviderErrorCode,
  InteractiveCredentialAuthorization,
  StoredRefreshCredential,
} from '@loom/credential-provider-api';

export interface RefreshCredentialStore {
  get(providerId: string): Promise<StoredRefreshCredential | undefined>;
  set(providerId: string, credential: StoredRefreshCredential): Promise<void>;
  delete(providerId: string): Promise<void>;
}

/** Compatibility name retained for existing Phase 4 provider implementations. */
export type ExtensionCredentialProvider = CredentialProvider;

export interface BrokerClock {
  now(): number;
}

export interface CachedAccessToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

export type BrokerErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED_ORIGIN'
  | 'UNKNOWN_PROVIDER'
  | 'MISSING_CREDENTIAL'
  | 'REFRESH_FAILED'
  | 'INTERNAL_ERROR';

export class ExtensionBrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionBrokerError';
    this.code = code;
  }
}
