import {
  CredentialBrokerError,
  credentialProviderId,
  type AccessToken,
  type CredentialBroker,
  type CredentialStatus,
  type CredentialProviderId,
  type GetAccessTokenInput,
} from '@loom/credential-broker-api';
import type { AuthProvider } from '@loom/plugin-api';

import { ExtensionAuthError } from './errors.js';

export interface ExtensionAuthConfiguration {
  readonly providerId: CredentialProviderId;
}

export interface CreateExtensionAuthProviderOptions {
  readonly broker: CredentialBroker;
  readonly providerId: string | CredentialProviderId;
}

export interface ExtensionAuthProvider extends AuthProvider {
  readonly configuration: ExtensionAuthConfiguration;
  getStatus(): Promise<CredentialStatus>;
  isAuthenticated(): Promise<boolean>;
  logout(): Promise<void>;
}

function optionsRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtensionAuthError(
      'INVALID_CONFIGURATION',
      'Extension authentication options are required.',
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function validateOptions(value: unknown): {
  readonly broker: CredentialBroker;
  readonly configuration: ExtensionAuthConfiguration;
} {
  const options = optionsRecord(value);
  const broker = options.broker;
  if (
    broker === null ||
    (typeof broker !== 'object' && typeof broker !== 'function') ||
    typeof (broker as Partial<CredentialBroker>).getAccessToken !== 'function' ||
    typeof (broker as Partial<CredentialBroker>).getStatus !== 'function' ||
    typeof (broker as Partial<CredentialBroker>).logout !== 'function'
  ) {
    throw new ExtensionAuthError(
      'INVALID_CONFIGURATION',
      'An explicit credential broker is required.',
    );
  }

  let providerId: CredentialProviderId;
  try {
    providerId = credentialProviderId(options.providerId as string);
  } catch (cause) {
    throw new ExtensionAuthError(
      'INVALID_CONFIGURATION',
      'A valid namespaced credential provider ID is required.',
      { cause },
    );
  }

  return {
    broker: broker as CredentialBroker,
    configuration: Object.freeze({ providerId }),
  };
}

function assertAccessToken(value: unknown, providerId: CredentialProviderId): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Partial<AccessToken>).accessToken !== 'string' ||
    (value as Partial<AccessToken>).accessToken?.trim().length === 0
  ) {
    throw new ExtensionAuthError(
      'INVALID_BROKER_RESPONSE',
      `Credential broker returned an invalid access token for provider "${providerId}".`,
      { details: { providerId } },
    );
  }
  return (value as AccessToken).accessToken;
}

function mapBrokerFailure(cause: unknown, providerId: CredentialProviderId): ExtensionAuthError {
  if (cause instanceof ExtensionAuthError) return cause;
  if (cause instanceof CredentialBrokerError) {
    return new ExtensionAuthError(
      'BROKER_REQUEST_FAILED',
      `Credential broker rejected the access-token request for provider "${providerId}".`,
      {
        cause,
        details: {
          providerId,
          brokerCode: cause.code,
          retryable: cause.retryable,
        },
      },
    );
  }
  return new ExtensionAuthError(
    'BROKER_REQUEST_FAILED',
    `Credential broker failed to provide an access token for provider "${providerId}".`,
    { cause, details: { providerId } },
  );
}

function assertStatus(value: unknown, providerId: CredentialProviderId): CredentialStatus {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Partial<CredentialStatus>).authenticated !== 'boolean'
  ) {
    throw new ExtensionAuthError(
      'INVALID_BROKER_RESPONSE',
      `Credential broker returned an invalid status for provider "${providerId}".`,
      { details: { providerId } },
    );
  }
  return Object.freeze({ authenticated: (value as CredentialStatus).authenticated });
}

export function createExtensionAuthProvider(
  options: CreateExtensionAuthProviderOptions,
): ExtensionAuthProvider {
  const { broker, configuration } = validateOptions(options);
  const request: GetAccessTokenInput = Object.freeze({
    providerId: configuration.providerId,
  });

  return Object.freeze({
    configuration,
    async getAccessToken(): Promise<string> {
      try {
        return assertAccessToken(await broker.getAccessToken(request), configuration.providerId);
      } catch (cause) {
        throw mapBrokerFailure(cause, configuration.providerId);
      }
    },
    async getStatus(): Promise<CredentialStatus> {
      try {
        return assertStatus(await broker.getStatus(request), configuration.providerId);
      } catch (cause) {
        throw mapBrokerFailure(cause, configuration.providerId);
      }
    },
    async isAuthenticated(): Promise<boolean> {
      try {
        return assertStatus(await broker.getStatus(request), configuration.providerId)
          .authenticated;
      } catch (cause) {
        throw mapBrokerFailure(cause, configuration.providerId);
      }
    },
    async logout(): Promise<void> {
      try {
        await broker.logout(request);
      } catch (cause) {
        throw mapBrokerFailure(cause, configuration.providerId);
      }
    },
  });
}
