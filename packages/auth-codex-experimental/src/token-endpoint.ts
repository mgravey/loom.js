import { CredentialProviderError } from '@mgravey/loom-credential-provider-api';

import type {
  OAuthClock,
  OAuthHttpResponse,
  OAuthHttpTransport,
  TokenEndpointResult,
} from './contracts.js';
import { base64UrlDecode, utf8Decode } from './encoding.js';
import { CodexExperimentalAuthError } from './errors.js';

interface TokenEndpointOptions {
  readonly transport: OAuthHttpTransport;
  readonly clock: OAuthClock;
  readonly endpoint: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(body: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(body);
    if (isRecord(value)) return value;
  } catch {
    // Sanitized below.
  }
  throw new CredentialProviderError('INVALID_RESPONSE', 'Token endpoint returned invalid JSON.');
}

function errorCode(response: OAuthHttpResponse): string | undefined {
  try {
    const value: unknown = JSON.parse(response.body);
    if (!isRecord(value)) return undefined;
    if (typeof value.error === 'string') return value.error.toLowerCase();
    if (isRecord(value.error) && typeof value.error.code === 'string') {
      return value.error.code.toLowerCase();
    }
    if (typeof value.code === 'string') return value.code.toLowerCase();
  } catch {
    // Error bodies remain private.
  }
  return undefined;
}

function isRejectedRefresh(response: OAuthHttpResponse): boolean {
  if (response.status === 401) return true;
  return new Set([
    'invalid_grant',
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
  ]).has(errorCode(response) ?? '');
}

function jwtExpiry(accessToken: string, clock: OAuthClock): number | undefined {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(utf8Decode(base64UrlDecode(payload)));
    if (!isRecord(decoded) || typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) {
      return undefined;
    }
    const expiry = decoded.exp * 1_000;
    return expiry > clock.now() && Number.isFinite(expiry) ? expiry : undefined;
  } catch {
    return undefined;
  }
}

function expiresAt(
  value: Readonly<Record<string, unknown>>,
  accessToken: string,
  clock: OAuthClock,
): number {
  if (typeof value.expires_in === 'number' && Number.isFinite(value.expires_in)) {
    const expiry = clock.now() + value.expires_in * 1_000;
    if (value.expires_in > 0 && Number.isFinite(expiry)) return expiry;
  }
  // The audited CLI also reads the access-token JWT's exp claim for refresh timing. The claim is
  // used only as a cache deadline, never as an identity or authorization boundary.
  const jwt = jwtExpiry(accessToken, clock);
  if (jwt !== undefined) return jwt;
  throw new CredentialProviderError(
    'INVALID_RESPONSE',
    'Token endpoint did not return a usable expiry.',
  );
}

function tokenResult(
  value: Readonly<Record<string, unknown>>,
  clock: OAuthClock,
  requireRefreshToken: boolean,
): TokenEndpointResult {
  if (typeof value.access_token !== 'string' || value.access_token.length === 0) {
    throw new CredentialProviderError(
      'INVALID_RESPONSE',
      'Token endpoint omitted an access token.',
    );
  }
  const refreshToken = value.refresh_token;
  if (requireRefreshToken && (typeof refreshToken !== 'string' || refreshToken.length === 0)) {
    throw new CredentialProviderError(
      'INVALID_RESPONSE',
      'Token endpoint omitted a refresh credential.',
    );
  }
  return Object.freeze({
    accessToken: value.access_token,
    expiresAt: expiresAt(value, value.access_token, clock),
    ...(typeof refreshToken === 'string' && refreshToken.length > 0
      ? { nextRefreshCredential: Object.freeze({ value: refreshToken }) }
      : {}),
    ...(typeof value.id_token === 'string' && value.id_token.length > 0
      ? { idToken: value.id_token }
      : {}),
  });
}

export async function sendTokenRequest(
  options: TokenEndpointOptions,
  body: string,
  contentType: string,
  mode: 'authorization' | 'refresh',
): Promise<TokenEndpointResult> {
  let response: OAuthHttpResponse;
  try {
    response = await options.transport.send({
      method: 'POST',
      url: options.endpoint,
      headers: Object.freeze({ 'content-type': contentType }),
      body,
    });
  } catch (cause) {
    throw new CredentialProviderError('TEMPORARY_FAILURE', 'Token endpoint is unavailable.', {
      cause,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    if (mode === 'refresh' && isRejectedRefresh(response)) {
      throw new CredentialProviderError(
        'CREDENTIAL_REJECTED',
        'The refresh credential is no longer valid.',
      );
    }
    throw new CredentialProviderError('TEMPORARY_FAILURE', 'Token endpoint rejected the request.');
  }
  try {
    return tokenResult(parseJson(response.body), options.clock, mode === 'authorization');
  } catch (cause) {
    if (cause instanceof CredentialProviderError) throw cause;
    throw new CodexExperimentalAuthError('INVALID_RESPONSE', 'Token response is invalid.', {
      cause,
    });
  }
}
