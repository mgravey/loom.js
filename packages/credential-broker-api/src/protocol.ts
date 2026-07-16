declare const credentialProviderIdBrand: unique symbol;

/** A provider identity using Loom's lowercase `namespace/name` syntax. */
export type CredentialProviderId = string & {
  readonly [credentialProviderIdBrand]: 'CredentialProviderId';
};

export const CREDENTIAL_BROKER_PROTOCOL = 'loom/credential-broker' as const;
export const CREDENTIAL_BROKER_PROTOCOL_VERSION = 1 as const;
export const GET_ACCESS_TOKEN_MESSAGE_TYPE = 'getAccessToken' as const;
export const GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE = 'getAccessTokenResult' as const;
export const GET_CREDENTIAL_STATUS_MESSAGE_TYPE = 'getCredentialStatus' as const;
export const GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE = 'getCredentialStatusResult' as const;
export const LOGOUT_MESSAGE_TYPE = 'logout' as const;
export const LOGOUT_RESULT_MESSAGE_TYPE = 'logoutResult' as const;

export type CredentialBrokerErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'UNAUTHORIZED_REQUEST'
  | 'PROVIDER_NOT_FOUND'
  | 'AUTHENTICATION_REQUIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'BROKER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface CredentialProviderInput {
  readonly providerId: CredentialProviderId;
  readonly sessionId?: string;
}

export type GetAccessTokenInput = CredentialProviderInput;
export type GetCredentialStatusInput = CredentialProviderInput;
export type LogoutInput = CredentialProviderInput;

/** A short-lived bearer credential. `expiresAt` is Unix epoch time in milliseconds. */
export interface AccessToken {
  readonly accessToken: string;
  readonly expiresAt?: number;
}

/** Credential state that is safe to expose outside the extension. */
export interface CredentialStatus {
  readonly authenticated: boolean;
}

/** Transport-independent client contract implemented by credential broker adapters. */
export interface CredentialBroker {
  getAccessToken(input: GetAccessTokenInput): Promise<AccessToken>;
  getStatus(input: GetCredentialStatusInput): Promise<CredentialStatus>;
  logout(input: LogoutInput): Promise<void>;
}

interface RequestEnvelope extends CredentialProviderInput {
  readonly protocol: typeof CREDENTIAL_BROKER_PROTOCOL;
  readonly version: typeof CREDENTIAL_BROKER_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface GetAccessTokenRequest extends RequestEnvelope {
  readonly type: typeof GET_ACCESS_TOKEN_MESSAGE_TYPE;
}

export interface GetCredentialStatusRequest extends RequestEnvelope {
  readonly type: typeof GET_CREDENTIAL_STATUS_MESSAGE_TYPE;
}

export interface LogoutRequest extends RequestEnvelope {
  readonly type: typeof LOGOUT_MESSAGE_TYPE;
}

export type CredentialBrokerRequest =
  GetAccessTokenRequest | GetCredentialStatusRequest | LogoutRequest;

interface ResultEnvelope {
  readonly protocol: typeof CREDENTIAL_BROKER_PROTOCOL;
  readonly version: typeof CREDENTIAL_BROKER_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface CredentialBrokerFailureDetails {
  readonly code: CredentialBrokerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

interface FailureEnvelope extends ResultEnvelope {
  readonly ok: false;
  readonly error: CredentialBrokerFailureDetails;
}

export interface GetAccessTokenSuccess extends ResultEnvelope, AccessToken {
  readonly type: typeof GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE;
  readonly ok: true;
}

export interface GetAccessTokenFailure extends FailureEnvelope {
  readonly type: typeof GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE;
}

export interface GetCredentialStatusSuccess extends ResultEnvelope, CredentialStatus {
  readonly type: typeof GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE;
  readonly ok: true;
}

export interface GetCredentialStatusFailure extends FailureEnvelope {
  readonly type: typeof GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE;
}

export interface LogoutSuccess extends ResultEnvelope {
  readonly type: typeof LOGOUT_RESULT_MESSAGE_TYPE;
  readonly ok: true;
}

export interface LogoutFailure extends FailureEnvelope {
  readonly type: typeof LOGOUT_RESULT_MESSAGE_TYPE;
}

export type CredentialBrokerResponse =
  | GetAccessTokenSuccess
  | GetAccessTokenFailure
  | GetCredentialStatusSuccess
  | GetCredentialStatusFailure
  | LogoutSuccess
  | LogoutFailure;

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
const REQUEST_TYPES = [
  GET_ACCESS_TOKEN_MESSAGE_TYPE,
  GET_CREDENTIAL_STATUS_MESSAGE_TYPE,
  LOGOUT_MESSAGE_TYPE,
] as const;
const RESULT_TYPES = [
  GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE,
  GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE,
  LOGOUT_RESULT_MESSAGE_TYPE,
] as const;

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
  return normalizeRequest(
    requestValue(GET_ACCESS_TOKEN_MESSAGE_TYPE, requestId, input),
  ) as GetAccessTokenRequest;
}

export function createGetCredentialStatusRequest(
  requestId: string,
  input: GetCredentialStatusInput,
): GetCredentialStatusRequest {
  return normalizeRequest(
    requestValue(GET_CREDENTIAL_STATUS_MESSAGE_TYPE, requestId, input),
  ) as GetCredentialStatusRequest;
}

export function createLogoutRequest(requestId: string, input: LogoutInput): LogoutRequest {
  return normalizeRequest(requestValue(LOGOUT_MESSAGE_TYPE, requestId, input)) as LogoutRequest;
}

function requestValue(
  type: CredentialBrokerRequest['type'],
  requestId: string,
  input: CredentialProviderInput,
): unknown {
  return {
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type,
    requestId,
    providerId: input.providerId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export function createGetAccessTokenSuccess(
  requestId: string,
  token: AccessToken,
): GetAccessTokenSuccess {
  return normalizeSuccess({
    ...resultValue(GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE, requestId),
    ok: true,
    accessToken: token.accessToken,
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
  }) as GetAccessTokenSuccess;
}

export function createGetCredentialStatusSuccess(
  requestId: string,
  status: CredentialStatus,
): GetCredentialStatusSuccess {
  return normalizeSuccess({
    ...resultValue(GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE, requestId),
    ok: true,
    authenticated: status.authenticated,
  }) as GetCredentialStatusSuccess;
}

export function createLogoutSuccess(requestId: string): LogoutSuccess {
  return normalizeSuccess({
    ...resultValue(LOGOUT_RESULT_MESSAGE_TYPE, requestId),
    ok: true,
  }) as LogoutSuccess;
}

export function createGetAccessTokenFailure(
  requestId: string,
  error: CredentialBrokerFailureDetails,
): GetAccessTokenFailure {
  return normalizeFailure({
    ...resultValue(GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE, requestId),
    ok: false,
    error,
  }) as GetAccessTokenFailure;
}

export function createGetCredentialStatusFailure(
  requestId: string,
  error: CredentialBrokerFailureDetails,
): GetCredentialStatusFailure {
  return normalizeFailure({
    ...resultValue(GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE, requestId),
    ok: false,
    error,
  }) as GetCredentialStatusFailure;
}

export function createLogoutFailure(
  requestId: string,
  error: CredentialBrokerFailureDetails,
): LogoutFailure {
  return normalizeFailure({
    ...resultValue(LOGOUT_RESULT_MESSAGE_TYPE, requestId),
    ok: false,
    error,
  }) as LogoutFailure;
}

function resultValue(
  type: CredentialBrokerResponse['type'],
  requestId: string,
): ResultEnvelope & { readonly type: CredentialBrokerResponse['type'] } {
  return {
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type,
    requestId,
  };
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

export function parseCredentialBrokerRequest(value: unknown): CredentialBrokerRequest {
  assertProtocolVersion(value);
  return normalizeRequest(value);
}

export function parseGetAccessTokenRequest(value: unknown): GetAccessTokenRequest {
  const request = parseCredentialBrokerRequest(value);
  if (request.type !== GET_ACCESS_TOKEN_MESSAGE_TYPE)
    throw invalidRequest('Expected a getAccessToken request.');
  return request;
}

/** Validates untrusted transport data and returns an immutable normalized response. */
export function parseCredentialBrokerResponse(value: unknown): CredentialBrokerResponse {
  assertProtocolVersion(value);
  if (!isRecord(value) || value.ok === undefined) {
    throw invalidRequest('Credential broker response must include an ok discriminator.');
  }
  return value.ok === true ? normalizeSuccess(value) : normalizeFailure(value);
}

function normalizeRequest(value: unknown): CredentialBrokerRequest {
  if (
    !isRecordWithExactKeys(
      value,
      ['protocol', 'version', 'type', 'requestId', 'providerId'],
      ['sessionId'],
    )
  ) {
    throw invalidRequest('Malformed credential broker request.');
  }
  if (
    value.protocol !== CREDENTIAL_BROKER_PROTOCOL ||
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION ||
    !REQUEST_TYPES.includes(value.type as never) ||
    !isRequestId(value.requestId) ||
    !isCredentialProviderId(value.providerId) ||
    (value.sessionId !== undefined && !isSessionId(value.sessionId))
  )
    throw invalidRequest('Malformed credential broker request.');
  return Object.freeze({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: value.type,
    requestId: value.requestId,
    providerId: value.providerId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  }) as CredentialBrokerRequest;
}

function normalizeSuccess(value: unknown): CredentialBrokerResponse {
  if (!isRecord(value) || !RESULT_TYPES.includes(value.type as never)) {
    throw invalidRequest('Malformed successful credential broker response.');
  }
  const baseValid =
    value.protocol === CREDENTIAL_BROKER_PROTOCOL &&
    value.version === CREDENTIAL_BROKER_PROTOCOL_VERSION &&
    value.ok === true &&
    isRequestId(value.requestId);
  if (value.type === GET_ACCESS_TOKEN_RESULT_MESSAGE_TYPE) {
    if (
      !isRecordWithExactKeys(
        value,
        ['protocol', 'version', 'type', 'requestId', 'ok', 'accessToken'],
        ['expiresAt'],
      ) ||
      !baseValid ||
      !isNonEmptyString(value.accessToken) ||
      (value.expiresAt !== undefined && !isEpochMilliseconds(value.expiresAt))
    ) {
      throw invalidRequest('Malformed successful credential broker response.');
    }
    return Object.freeze({
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
      type: value.type,
      requestId: value.requestId,
      ok: true,
      accessToken: value.accessToken,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    }) as CredentialBrokerResponse;
  }
  if (value.type === GET_CREDENTIAL_STATUS_RESULT_MESSAGE_TYPE) {
    if (
      !isRecordWithExactKeys(value, [
        'protocol',
        'version',
        'type',
        'requestId',
        'ok',
        'authenticated',
      ]) ||
      !baseValid ||
      typeof value.authenticated !== 'boolean'
    ) {
      throw invalidRequest('Malformed successful credential broker response.');
    }
    return Object.freeze({
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
      type: value.type,
      requestId: value.requestId,
      ok: true,
      authenticated: value.authenticated,
    }) as CredentialBrokerResponse;
  }
  if (
    !isRecordWithExactKeys(value, ['protocol', 'version', 'type', 'requestId', 'ok']) ||
    !baseValid
  ) {
    throw invalidRequest('Malformed successful credential broker response.');
  }
  return Object.freeze({
    protocol: CREDENTIAL_BROKER_PROTOCOL,
    version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
    type: LOGOUT_RESULT_MESSAGE_TYPE,
    requestId: value.requestId,
    ok: true,
  }) as CredentialBrokerResponse;
}

function normalizeFailure(value: unknown): CredentialBrokerResponse {
  if (
    !isRecordWithExactKeys(value, ['protocol', 'version', 'type', 'requestId', 'ok', 'error']) ||
    !RESULT_TYPES.includes(value.type as never) ||
    !isRecordWithExactKeys(value.error, ['code', 'message', 'retryable']) ||
    value.protocol !== CREDENTIAL_BROKER_PROTOCOL ||
    value.version !== CREDENTIAL_BROKER_PROTOCOL_VERSION ||
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
    type: value.type,
    requestId: value.requestId,
    ok: false,
    error: Object.freeze({
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    }),
  }) as CredentialBrokerResponse;
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isRecordWithExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
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
