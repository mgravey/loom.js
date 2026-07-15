export interface StoredRefreshCredential {
  readonly value: string;
}

export interface RefreshCredentialStore {
  get(providerId: string): Promise<StoredRefreshCredential | undefined>;
  set(providerId: string, credential: StoredRefreshCredential): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export interface AccessTokenResult {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly nextRefreshCredential?: StoredRefreshCredential;
}

export interface ExtensionCredentialProvider {
  readonly id: string;
  refresh(credential: StoredRefreshCredential): Promise<AccessTokenResult>;
}

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
