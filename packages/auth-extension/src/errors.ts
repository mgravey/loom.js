import type {
  CredentialBrokerErrorCode,
  CredentialProviderId,
} from '@mgravey/loom-credential-broker-api';

export type ExtensionAuthErrorCode =
  'INVALID_CONFIGURATION' | 'BROKER_REQUEST_FAILED' | 'INVALID_BROKER_RESPONSE';

export interface ExtensionAuthErrorDetails {
  readonly providerId?: CredentialProviderId;
  readonly brokerCode?: CredentialBrokerErrorCode;
  readonly retryable?: boolean;
}

/** A provider-neutral failure raised while adapting the credential broker to Loom auth. */
export class ExtensionAuthError extends Error {
  public readonly code: ExtensionAuthErrorCode;
  public readonly details: Readonly<ExtensionAuthErrorDetails>;

  public constructor(
    code: ExtensionAuthErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: ExtensionAuthErrorDetails;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ExtensionAuthError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}
