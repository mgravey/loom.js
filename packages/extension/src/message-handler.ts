import {
  CredentialBrokerError,
  createGetAccessTokenFailure,
  createGetAccessTokenSuccess,
  parseGetAccessTokenRequest,
  type CredentialBrokerErrorCode,
  type CredentialBrokerResponse,
} from '@loom/credential-broker-api';

import type { ChromeExternalMessageListener, ChromeMessageSender } from './chrome-contracts.js';
import { ExtensionBrokerError, type BrokerErrorCode } from './contracts.js';
import type { OriginAuthorizer } from './origins.js';
import type { ExtensionTokenService } from './token-service.js';

export interface CreateCredentialBrokerMessageHandlerOptions {
  readonly authorizer: OriginAuthorizer;
  readonly tokenService: ExtensionTokenService;
}

export interface CredentialBrokerMessageHandler {
  handle(message: unknown, sender: ChromeMessageSender): Promise<CredentialBrokerResponse>;
}

const FALLBACK_REQUEST_ID = 'invalid-request';

function requestIdFrom(message: unknown): string {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return FALLBACK_REQUEST_ID;
  }
  const requestId = (message as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && requestId.trim().length > 0 && requestId.length <= 256
    ? requestId
    : FALLBACK_REQUEST_ID;
}

const errorCodeMap: Readonly<Record<BrokerErrorCode, CredentialBrokerErrorCode>> = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED_ORIGIN: 'UNAUTHORIZED_REQUEST',
  UNKNOWN_PROVIDER: 'PROVIDER_NOT_FOUND',
  MISSING_CREDENTIAL: 'AUTHENTICATION_REQUIRED',
  REFRESH_FAILED: 'TOKEN_REFRESH_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

function failureDetails(error: unknown): {
  readonly code: CredentialBrokerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof ExtensionBrokerError) {
    const code = errorCodeMap[error.code];
    return Object.freeze({
      code,
      message: error.message,
      retryable: code === 'TOKEN_REFRESH_FAILED',
    });
  }
  if (error instanceof CredentialBrokerError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    code: 'INTERNAL_ERROR',
    message: 'The credential broker could not complete the request.',
    retryable: false,
  });
}

export function createCredentialBrokerMessageHandler(
  options: CreateCredentialBrokerMessageHandlerOptions,
): CredentialBrokerMessageHandler {
  return Object.freeze({
    async handle(message: unknown, sender: ChromeMessageSender) {
      const fallbackRequestId = requestIdFrom(message);
      try {
        options.authorizer.assertAuthorized(sender);
        const request = parseGetAccessTokenRequest(message);
        const token = await options.tokenService.getAccessToken(request.providerId);
        return createGetAccessTokenSuccess(request.requestId, token);
      } catch (error) {
        return createGetAccessTokenFailure(fallbackRequestId, failureDetails(error));
      }
    },
  });
}

export function createChromeExternalMessageListener(
  handler: CredentialBrokerMessageHandler,
): ChromeExternalMessageListener {
  return (message, sender, sendResponse) => {
    void handler.handle(message, sender).then(sendResponse, () => {
      sendResponse(
        createGetAccessTokenFailure(FALLBACK_REQUEST_ID, {
          code: 'INTERNAL_ERROR',
          message: 'The credential broker could not complete the request.',
          retryable: false,
        }),
      );
    });
    return true;
  };
}
