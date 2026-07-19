import {
  ExtensionBrokerError,
  type ChromeExternalMessageListener,
  type ChromeMessageSender,
  type ExtensionTokenService,
  type OriginAuthorizer,
} from '@loom/extension';

import type { CodexAccountRoutingStore } from './account-routing.js';

export const CODEX_DIRECT_AUTH_PROTOCOL = 'loom/codex-direct-auth-experimental' as const;
export const CODEX_DIRECT_AUTH_VERSION = 1 as const;

interface DirectAuthRequest {
  readonly protocol: typeof CODEX_DIRECT_AUTH_PROTOCOL;
  readonly version: typeof CODEX_DIRECT_AUTH_VERSION;
  readonly type: 'getDirectCredentials';
  readonly requestId: string;
  readonly providerId: string;
}

export interface CreateCodexDirectAuthListenerOptions {
  readonly providerId: string;
  readonly authorizer: OriginAuthorizer;
  readonly tokenService: ExtensionTokenService;
  readonly accountRoutingStore: CodexAccountRoutingStore;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown, providerId: string): DirectAuthRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['protocol', 'version', 'type', 'requestId', 'providerId'].includes(key),
    ) ||
    value.protocol !== CODEX_DIRECT_AUTH_PROTOCOL ||
    value.version !== CODEX_DIRECT_AUTH_VERSION ||
    value.type !== 'getDirectCredentials' ||
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9._:-]{1,256}$/u.test(value.requestId) ||
    value.providerId !== providerId
  ) {
    throw new Error('Invalid direct-auth request.');
  }
  return value as unknown as DirectAuthRequest;
}

function fallbackRequestId(value: unknown): string {
  if (!isRecord(value)) return 'invalid-request';
  return typeof value.requestId === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/u.test(value.requestId)
    ? value.requestId
    : 'invalid-request';
}

function errorCode(error: unknown): string {
  if (error instanceof ExtensionBrokerError) {
    if (error.code === 'UNAUTHORIZED_ORIGIN') return 'UNAUTHORIZED_REQUEST';
    if (error.code === 'MISSING_CREDENTIAL') return 'AUTHENTICATION_REQUIRED';
    if (error.code === 'REFRESH_FAILED') return 'TOKEN_REFRESH_FAILED';
  }
  return 'INTERNAL_ERROR';
}

export function isCodexDirectAuthRequest(value: unknown): boolean {
  return isRecord(value) && value.protocol === CODEX_DIRECT_AUTH_PROTOCOL;
}

export function createCodexDirectAuthListener(
  options: CreateCodexDirectAuthListenerOptions,
): ChromeExternalMessageListener {
  return (message: unknown, sender: ChromeMessageSender, sendResponse) => {
    void (async () => {
      const requestId = fallbackRequestId(message);
      try {
        await options.authorizer.assertAuthorized(sender);
        const request = parseRequest(message, options.providerId);
        const accountId = await options.accountRoutingStore.get();
        if (accountId === undefined) {
          throw new ExtensionBrokerError(
            'MISSING_CREDENTIAL',
            'ChatGPT account routing is unavailable.',
          );
        }
        const token = await options.tokenService.getAccessToken(options.providerId);
        sendResponse(
          Object.freeze({
            protocol: CODEX_DIRECT_AUTH_PROTOCOL,
            version: CODEX_DIRECT_AUTH_VERSION,
            type: 'getDirectCredentialsResult',
            requestId: request.requestId,
            ok: true,
            accessToken: token.accessToken,
            accountId,
            expiresAt: token.expiresAt,
          }),
        );
      } catch (error) {
        sendResponse(
          Object.freeze({
            protocol: CODEX_DIRECT_AUTH_PROTOCOL,
            version: CODEX_DIRECT_AUTH_VERSION,
            type: 'getDirectCredentialsResult',
            requestId,
            ok: false,
            error: Object.freeze({ code: errorCode(error) }),
          }),
        );
      }
    })();
    return true;
  };
}
