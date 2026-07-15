import type {
  AccessTokenResult,
  CredentialProvider,
  InteractiveCredentialAuthorization,
} from '@loom/credential-provider-api';

export interface CodexOAuthConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly providerId?: string;
  readonly scopes?: readonly string[];
  readonly authorizationParameters?: Readonly<Record<string, string>>;
  readonly pollTimeoutMs?: number;
}

export interface OAuthHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface OAuthHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface OAuthHttpTransport {
  send(request: OAuthHttpRequest): Promise<OAuthHttpResponse>;
}

export interface OAuthClock {
  now(): number;
}

export interface OAuthDelay {
  wait(milliseconds: number): Promise<void>;
}

export interface Sha256Digest {
  digest(input: Uint8Array): Promise<Uint8Array>;
}

export interface SecureRandomSource {
  randomBytes(length: number): Uint8Array;
}

export interface OAuthBrowserRedirect {
  getRedirectUri(): string;
  launchAuthorization(url: string): Promise<string>;
}

export interface AuthorizationTransaction {
  readonly providerId: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface AuthorizationTransactionStore {
  put(transaction: AuthorizationTransaction): Promise<void>;
  take(providerId: string): Promise<AuthorizationTransaction | undefined>;
  delete(providerId: string): Promise<void>;
}

export interface DeviceAuthorizationPrompt {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
}

export interface DeviceAuthorizationInteraction {
  present(prompt: DeviceAuthorizationPrompt): Promise<void>;
}

export interface CodexExperimentalAuth {
  readonly provider: CredentialProvider;
  readonly authorization: InteractiveCredentialAuthorization;
}

export interface CodexOAuthDependencies {
  readonly transport: OAuthHttpTransport;
  readonly clock?: OAuthClock;
}

export interface CodexDeviceAuthorizationDependencies extends CodexOAuthDependencies {
  readonly digest: Sha256Digest;
  readonly delay: OAuthDelay;
  readonly interaction: DeviceAuthorizationInteraction;
}

export interface CodexRedirectAuthorizationDependencies extends CodexOAuthDependencies {
  readonly digest: Sha256Digest;
  readonly random: SecureRandomSource;
  readonly redirect: OAuthBrowserRedirect;
  readonly transactions: AuthorizationTransactionStore;
  readonly transactionTtlMs?: number;
  /** Must be supplied only after the exact redirect URI is registered by the provider. */
  readonly redirectRegistrationApproved: boolean;
}

export interface TokenEndpointResult extends AccessTokenResult {
  readonly idToken?: string;
}
