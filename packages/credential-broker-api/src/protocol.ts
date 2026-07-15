declare const credentialProviderIdBrand: unique symbol;

/** A provider identity using Loom's lowercase `namespace/name` syntax. */
export type CredentialProviderId = string & {
  readonly [credentialProviderIdBrand]: 'CredentialProviderId';
};

export const CREDENTIAL_BROKER_PROTOCOL = 'loom/credential-broker' as const;
export const CREDENTIAL_BROKER_PROTOCOL_VERSION = 1 as const;
export const GET_ACCESS_TOKEN_MESSAGE_TYPE = 'getAccessToken' as const;
export const GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE = 'getAccessTokenResult' as const;

export type CredentialBrokerErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'UNAUTHORIZED_REQUEST'
  | 'PROVIDER_NOT_FOUND'
  | 'AUTHENTICATION_REQUIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'BROKER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface GetAccessTokenInput {
  readonly providerId: CredentialProviderId;
  readonly sessionId?: string;
}

/** A short-lived bearer credential. `expiresAt` is Unix epoch time in milliseconds. */
export interface AccessToken {
  readonly accessToken: string;
  readonly expiresAt?: number;
}

/** Transport-independent client contract implemented by credential broker adapters. */
export interface CredentialBroker {
  getAccessToken(input: GetAccessTokenInput): Promise<AccessToken>;
}

export interface GetAccessTokenRequest extends GetAccessTokenInput {
  readonly protocol: typeof CREDENTIAL_BROKER_PROTOCOL;
  readonly version: typeof CREDENTIAL_BROKER_PROTOCOL_VERSION;
  readonly type: typeof GET_ACCESS_TOKEN_MESSAGE_TYPE;
  readonly requestId: string;
}

interface GetAccessTokenResultEnvelope {
  readonly protocol: typeof CREDENTIAL_BROKER_PROTOCOL;
  readonly version: typeof CREDENTIAL_BROKER_PROTOCOL_VERSION;
  readonly type: typeof GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE;
  readonly requestId: string;
}

export interface GetAccessTokenSuccess extends GetAccessTokenResultEnvelope, AccessToken {
  readonly ok: true;
}

export interface CredentialBrokerFailureDetails {
  readonly code: CredentialBrokerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface GetAccessTokenFailure extends GetAccessTokenResultEnvelope {
  readonly ok: false;
  readonly error: CredentialBrokerFailureDetails;
}

export type CredentialBrokerResponse = GetAccessTokenSuccess | GetAccessTokenFailure;

export class CredentialBrokerError extends Error {
  public readonly code: CredentialBrokerErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: CredentialBrokerErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CredentialBrokerError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const NAMESPACED_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const ERROR_CODES: ReadonlySet<string> = new Set<CredentialBrokerErrorCode>([
  'INVALID_REQUEST',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'UNAUTHORIZED_REQUEST',
  'PROVIDER_NOT_FOUND',
  'AUTHENTICATION_REQUIRED',
  'TOKEN_REFRESH_FAILED',
  'BROKER_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export function isCredentialProviderId(value: unknown): value is CredentialProviderId {
  return typeof value === 'string' && NAMESPACED_ID.test(value);
}

export function credentialProviderId(value: string): CredentialProviderId {
  if (!isCredentialProviderId(value)) {
    throw new TypeError(
      `Invalid credential provider ID "${value}". Expected lowercase "namespace/name" syntax.`,
    );
  }
  return value;
}

export function createGetAccessTokenRequest(
  requestId: string,
  input: GetAccessTokenInput,
): GetAccessTokenRequest {
  return normalizeRequest({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_MESSAGE_TYPE,
    requestId,
    providerId: input.providerId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  });
}

export function createGetAccessTokenSuccess(
  requestId: string,
  token: AccessToken,
): GetAccessTokenSuccess {
  return normalizeSuccess({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE,
    requestId,
    ok: true,
    accessToken: token.accessToken,
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
  });
}

export function createGetAccessTokenFailure(
  requestId: string,
  error: CredentialBrokerFailureDetails,
): GetAccessTokenFailure {
  return normalizeFailure({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE,
    requestId,
    ok: false,
    error,
  });
}

export function isGetAccessTokenRequest(value: unknown): value is GetAccessTokenRequest {
  try {
    parseGetAccessTokenRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function isCredentialBrokerResponse(value: unknown): value is CredentialBrokerResponse {
  try {
    parseCredentialBrokerResponse(value);
    return true;
  } catch {
    return false;
  }
}

/** Validates untrusted transport data and returns an immutable normalized request. */
export function parseGetAccessTokenRequest(value: unknown): GetAccessTokenRequest {
  assertProtocolVersion(value);
  return normalizeRequest(value);
}

/** Validates untrusted transport data and returns an immutable normalized response. */
export function parseCredentialBrokerResponse(value: unknown): CredentialBrokerResponse {
  assertProtocolVersion(value);
  if (!isRecord(value) || value.ok === undefined) {
    throw invalidRequest('Credential broker response must include an ok discriminator.');
  }
  return value.ok === true ? normalizeSuccess(value) : normalizeFailure(value);
}

function normalizeRequest(value: unknown): GetAccessTokenRequest {
  if (
    !isRecordWithExactKeys(
      value,
      ['protocol', 'version', 'type', 'requestId', 'providerId'],
      ['sessionId'],
    )
  ) {
    throw invalidRequest('Malformed getAccessToken request.');
  }
  if (
    value.protocol !== CREDENTIAL_BROKER_PROTOCOL ||
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION ||
    value.type !== GET_ACCESS_TOKEN_MESSAGE_TYPE ||
    !isRequestId(value.requestId) ||
    !isCredentialProviderId(value.providerId) ||
    (value.sessionId !== undefined && !isSessionId(value.sessionId))
  ) {
    throw invalidRequest('Malformed getAccessToken request.');
  }
  return Object.freeze({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_MESSAGE_TYPE,
    requestId: value.requestId,
    providerId: value.providerId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  });
}

function normalizeSuccess(value: unknown): GetAccessTokenSuccess {
  if (
    !isRecordWithExactKeys(
      value,
      ['protocol', 'version', 'type', 'requestId', 'ok', 'accessToken'],
      ['expiresAt'],
    )
  ) {
    throw invalidRequest('Malformed successful credential broker response.');
  }
  if (
    value.protocol !== CREDENTIAL_BROKER_PROTOCOL ||
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION ||
    value.type !== GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE ||
    value.ok !== true ||
    !isRequestId(value.requestId) ||
    !isNonEmptyString(value.accessToken) ||
    (value.expiresAt !== undefined && !isEpochMilliseconds(value.expiresAt))
  ) {
    throw invalidRequest('Malformed successful credential broker response.');
  }
  return Object.freeze({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE,
    requestId: value.requestId,
    ok: true,
    accessToken: value.accessToken,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  });
}

function normalizeFailure(value: unknown): GetAccessTokenFailure {
  if (
    !isRecordWithExactKeys(value, ['protocol', 'version', 'type', 'requestId', 'ok', 'error']) ||
    !isRecordWithExactKeys(value.error, ['code', 'message', 'retryable'])
  ) {
    throw invalidRequest('Malformed failed credential broker response.');
  }
  if (
    value.protocol !== CREDENTIAL_BROKER_PROTOCOL ||
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION ||
    value.type !== GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE ||
    value.ok !== false ||
    !isRequestId(value.requestId) ||
    !isCredentialBrokerErrorCode(value.error.code) ||
    !isNonEmptyString(value.error.message) ||
    typeof value.error.retryable !== 'boolean'
  ) {
    throw invalidRequest('Malformed failed credential broker response.');
  }
  return Object.freeze({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE,
    requestId: value.requestId,
    ok: false,
    error: Object.freeze({
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    }),
  });
}

function assertProtocolVersion(value: unknown): void {
  if (
    isRecord(value) &&
    value.protocol === CREDENTIAL_BROKER_PROTOCOL &&
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION
  ) {
    throw new CredentialBrokerError(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Unsupported credential broker protocol version: ${String(value.version)}.`,
    );
  }
}

function isCredentialBrokerErrorCode(value: unknown): value is CredentialBrokerErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isRecordWithExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRequestId(value: unknown): value is string {
  return isBoundedNonEmptyString(value, 256);
}

function isSessionId(value: unknown): value is string {
  return isBoundedNonEmptyString(value, 256);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maximumLength;
}

function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidRequest(message: string): CredentialBrokerError {
  return new CredentialBrokerError('INVALID_REQUEST', message);
}
