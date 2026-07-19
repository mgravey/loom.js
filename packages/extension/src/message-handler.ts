import {
  CredentialBrokerError,
  GET_CREDENTIAL_STATUS_MESSAGE_TYPE,
  LOGOUT_MESSAGE_TYPE,
  createGetCredentialStatusFailure,
  createGetCredentialStatusSuccess,
  createGetAccessTokenFailure,
  createGetAccessTokenSuccess,
  createLogoutFailure,
  createLogoutSuccess,
  parseCredentialBrokerRequest,
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
  /** Defaults to true for the generic broker. Credential-isolating bridges should disable it. */
  readonly allowAccessTokenResponses?: boolean;
}

export interface CredentialBrokerMessageHandler {
  handle(message: unknown, sender: ChromeMessageSender): Promise<CredentialBrokerResponse>;
}

const FALLBACK_REQUEST_ID = 'invalid-request';

type ResponseOperation = 'token' | 'status' | 'logout';

function requestIdFrom(message: unknown): string {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return FALLBACK_REQUEST_ID;
  }
  const requestId = (message as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && requestId.trim().length > 0 && requestId.length <= 256
    ? requestId
    : FALLBACK_REQUEST_ID;
}

function operationFrom(message: unknown): ResponseOperation {
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const type = (message as Record<string, unknown>).type;
    if (type === GET_CREDENTIAL_STATUS_MESSAGE_TYPE) return 'status';
    if (type === LOGOUT_MESSAGE_TYPE) return 'logout';
  }
  return 'token';
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

function createFailure(
  operation: ResponseOperation,
  requestId: string,
  details: ReturnType<typeof failureDetails>,
): CredentialBrokerResponse {
  if (operation === 'status') return createGetCredentialStatusFailure(requestId, details);
  if (operation === 'logout') return createLogoutFailure(requestId, details);
  return createGetAccessTokenFailure(requestId, details);
}

export function createCredentialBrokerMessageHandler(
  options: CreateCredentialBrokerMessageHandlerOptions,
): CredentialBrokerMessageHandler {
  return Object.freeze({
    async handle(message: unknown, sender: ChromeMessageSender) {
      const fallbackRequestId = requestIdFrom(message);
      const operation = operationFrom(message);
      try {
        await options.authorizer.assertAuthorized(sender);
        const request = parseCredentialBrokerRequest(message);
        if (request.type === GET_CREDENTIAL_STATUS_MESSAGE_TYPE) {
          const status = await options.tokenService.getStatus(request.providerId);
          return createGetCredentialStatusSuccess(request.requestId, status);
        }
        if (request.type === LOGOUT_MESSAGE_TYPE) {
          await options.tokenService.logout(request.providerId);
          return createLogoutSuccess(request.requestId);
        }
        if (options.allowAccessTokenResponses === false) {
          throw new CredentialBrokerError(
            'UNAUTHORIZED_REQUEST',
            'This extension does not expose access tokens to web pages.',
          );
        }
        const token = await options.tokenService.getAccessToken(request.providerId);
        return createGetAccessTokenSuccess(request.requestId, token);
      } catch (error) {
        return createFailure(operation, fallbackRequestId, failureDetails(error));
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
        createFailure('token', FALLBACK_REQUEST_ID, {
          code: 'INTERNAL_ERROR',
          message: 'The credential broker could not complete the request.',
          retryable: false,
        }),
      );
    });
    return true;
  };
}
