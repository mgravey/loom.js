/** An opaque credential that can be exchanged for another access token. */
export interface StoredRefreshCredential {
  readonly value: string;
}

/** A provider result whose expiry is Unix epoch time in milliseconds. */
export interface AccessTokenResult {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly nextRefreshCredential?: StoredRefreshCredential;
}

/** Host-neutral credential refresh contract implemented by provider packages. */
export interface CredentialProvider {
  readonly id: string;
  refresh(credential: StoredRefreshCredential): Promise<AccessTokenResult>;
}

/** Optional interactive authorization entry point owned by the provider host. */
export interface InteractiveCredentialAuthorization {
  readonly providerId: string;
  authorize(): Promise<AccessTokenResult>;
}

export type CredentialProviderErrorCode =
  'CREDENTIAL_REJECTED' | 'TEMPORARY_FAILURE' | 'INVALID_RESPONSE';

/** A sanitized provider failure that a host can handle without provider-specific imports. */
export class CredentialProviderError extends Error {
  public readonly code: CredentialProviderErrorCode;

  public constructor(code: CredentialProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialProviderError';
    this.code = code;
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<CredentialProviderErrorCode>([
  'CREDENTIAL_REJECTED',
  'TEMPORARY_FAILURE',
  'INVALID_RESPONSE',
]);

export function isCredentialProviderError(value: unknown): value is CredentialProviderError {
  if (value instanceof CredentialProviderError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly name?: unknown };
  return candidate.name === 'CredentialProviderError' && ERROR_CODES.has(String(candidate.code));
}
