import {
  CredentialBrokerError,
  createGetAccessTokenRequest,
  parseCredentialBrokerResponse,
  type AccessToken,
  type CredentialBroker,
  type GetAccessTokenInput,
  type GetAccessTokenRequest,
} from '@loom/credential-broker-api';

/** The minimal injected surface needed from an extension external-message runtime. */
export interface ExternalMessageRuntime {
  readonly lastError?: { readonly message?: string };
  sendMessage(
    extensionId: string,
    message: unknown,
    options: undefined,
    callback: (response: unknown) => void,
  ): unknown;
}

export interface ExternalCredentialBrokerConfiguration {
  readonly extensionId: string;
}

export interface ExternalCredentialBroker extends CredentialBroker {
  readonly configuration: ExternalCredentialBrokerConfiguration;
}

export interface CreateExternalCredentialBrokerOptions {
  readonly extensionId: string;
  readonly runtime: ExternalMessageRuntime;
  /** Optional deterministic request-ID source for tests or host-level tracing. */
  readonly requestIdFactory?: () => string;
}

function validateOptions(value: unknown): {
  readonly configuration: ExternalCredentialBrokerConfiguration;
  readonly runtime: ExternalMessageRuntime;
  readonly requestIdFactory: () => string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('External credential broker options are required.');
  }
  const options = value as Readonly<Record<string, unknown>>;
  if (typeof options.extensionId !== 'string' || options.extensionId.trim().length === 0) {
    throw new TypeError('A non-empty extension ID is required.');
  }
  const runtime = options.runtime;
  if (
    runtime === null ||
    (typeof runtime !== 'object' && typeof runtime !== 'function') ||
    typeof (runtime as Partial<ExternalMessageRuntime>).sendMessage !== 'function'
  ) {
    throw new TypeError('An explicit external-message runtime is required.');
  }
  if (options.requestIdFactory !== undefined && typeof options.requestIdFactory !== 'function') {
    throw new TypeError('requestIdFactory must be a function when provided.');
  }

  let nextRequest = 0;
  const defaultRequestIdFactory = (): string => {
    nextRequest += 1;
    return `loom-auth-${String(nextRequest)}`;
  };
  return {
    configuration: Object.freeze({ extensionId: options.extensionId }),
    runtime: runtime as ExternalMessageRuntime,
    requestIdFactory:
      (options.requestIdFactory as (() => string) | undefined) ?? defaultRequestIdFactory,
  };
}

function transportFailure(cause: unknown): CredentialBrokerError {
  if (cause instanceof CredentialBrokerError) return cause;
  return new CredentialBrokerError('BROKER_UNAVAILABLE', 'Credential broker transport failed.', {
    cause,
    retryable: true,
  });
}

function sendExternalMessage(
  runtime: ExternalMessageRuntime,
  extensionId: string,
  request: GetAccessTokenRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (cause: Error): void => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    const callback = (response: unknown): void => {
      const lastError = runtime.lastError;
      if (lastError !== undefined) {
        rejectOnce(new Error(lastError.message ?? 'External-message transport failed.'));
      } else {
        resolveOnce(response);
      }
    };

    try {
      const returned = runtime.sendMessage(extensionId, request, undefined, callback);
      if (
        returned !== null &&
        (typeof returned === 'object' || typeof returned === 'function') &&
        typeof (returned as PromiseLike<unknown>).then === 'function'
      ) {
        void Promise.resolve(returned as PromiseLike<unknown>).then(resolveOnce, (cause: unknown) =>
          rejectOnce(
            cause instanceof Error
              ? cause
              : new Error('External-message transport rejected.', { cause }),
          ),
        );
      } else if (returned !== undefined) {
        resolveOnce(returned);
      }
    } catch (cause) {
      rejectOnce(
        cause instanceof Error
          ? cause
          : new Error('External-message transport threw a non-error value.', { cause }),
      );
    }
  });
}

function immutableToken(accessToken: string, expiresAt?: number): AccessToken {
  return Object.freeze({
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function createExternalCredentialBroker(
  options: CreateExternalCredentialBrokerOptions,
): ExternalCredentialBroker {
  const { configuration, runtime, requestIdFactory } = validateOptions(options);
  return Object.freeze({
    configuration,
    async getAccessToken(input: GetAccessTokenInput): Promise<AccessToken> {
      let request: GetAccessTokenRequest;
      try {
        request = createGetAccessTokenRequest(requestIdFactory(), input);
      } catch (cause) {
        throw transportFailure(cause);
      }

      let untrustedResponse: unknown;
      try {
        untrustedResponse = await sendExternalMessage(runtime, configuration.extensionId, request);
      } catch (cause) {
        throw transportFailure(cause);
      }

      const response = parseCredentialBrokerResponse(untrustedResponse);
      if (response.requestId !== request.requestId) {
        throw new CredentialBrokerError(
          'INVALID_REQUEST',
          'Credential broker response request ID does not match the request.',
        );
      }
      if (!response.ok) {
        throw new CredentialBrokerError(response.error.code, response.error.message, {
          retryable: response.error.retryable,
        });
      }
      return immutableToken(response.accessToken, response.expiresAt);
    },
  });
}
