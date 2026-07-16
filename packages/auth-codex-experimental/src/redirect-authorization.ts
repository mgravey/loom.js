import type {
  CodexInteractiveCredentialAuthorization,
  CodexOAuthConfiguration,
  CodexRedirectAuthorizationDependencies,
  OAuthClock,
} from './contracts.js';
import { normalizeConfiguration } from './configuration.js';
import {
  asciiBytes,
  base64UrlEncode,
  constantTimeEqual,
  formEncode,
  queryParameters,
} from './encoding.js';
import { CodexExperimentalAuthError } from './errors.js';
import { sendTokenRequest } from './token-endpoint.js';

const RESERVED_PARAMETERS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'state',
]);
const systemClock: OAuthClock = Object.freeze({ now: Date.now });

function callbackQuery(callback: string, redirectUri: string): string {
  if (!callback.startsWith(redirectUri)) {
    throw new CodexExperimentalAuthError('INVALID_CALLBACK', 'OAuth callback URI does not match.');
  }
  const suffix = callback.slice(redirectUri.length);
  if (suffix.length === 0) return '';
  if (!suffix.startsWith('?') || suffix.includes('#')) {
    throw new CodexExperimentalAuthError('INVALID_CALLBACK', 'OAuth callback URI does not match.');
  }
  return suffix.slice(1);
}

export function createCodexExperimentalRedirectAuthorization(
  configuration: CodexOAuthConfiguration,
  dependencies: CodexRedirectAuthorizationDependencies,
): CodexInteractiveCredentialAuthorization {
  const normalized = normalizeConfiguration(configuration);
  const clock = dependencies.clock ?? systemClock;
  const transactionTtlMs = dependencies.transactionTtlMs ?? 10 * 60 * 1_000;
  if (!Number.isFinite(transactionTtlMs) || transactionTtlMs <= 0) {
    throw new RangeError('Authorization transaction TTL must be positive and finite.');
  }
  for (const key of Object.keys(normalized.authorizationParameters)) {
    if (RESERVED_PARAMETERS.has(key)) {
      throw new TypeError(`Authorization parameter "${key}" is reserved.`);
    }
  }

  return Object.freeze({
    providerId: normalized.providerId,
    async authorize() {
      if (!dependencies.redirectRegistrationApproved) {
        throw new CodexExperimentalAuthError(
          'EXPERIMENT_DISABLED',
          'Direct browser authorization requires an explicitly registered extension redirect.',
        );
      }
      const redirectUri = dependencies.redirect.getRedirectUri();
      if (!/^https:\/\/[^/?#]+\/[^?#]*$/u.test(redirectUri)) {
        throw new CodexExperimentalAuthError(
          'INVALID_CALLBACK',
          'Registered browser redirect must be an absolute HTTPS URI.',
        );
      }
      const state = base64UrlEncode(dependencies.random.randomBytes(32));
      const verifier = base64UrlEncode(dependencies.random.randomBytes(64));
      if (state.length < 43 || verifier.length < 43 || verifier.length > 128) {
        throw new CodexExperimentalAuthError(
          'INVALID_PKCE',
          'Secure randomness returned an invalid PKCE transaction.',
        );
      }
      const challenge = base64UrlEncode(await dependencies.digest.digest(asciiBytes(verifier)));
      await dependencies.transactions.put(
        Object.freeze({
          providerId: normalized.providerId,
          state,
          verifier,
          redirectUri,
          createdAt: clock.now(),
        }),
      );
      const parameters: (readonly [string, string])[] = [
        ['response_type', 'code'],
        ['client_id', normalized.clientId],
        ['redirect_uri', redirectUri],
        ['scope', normalized.scopes.join(' ')],
        ['code_challenge', challenge],
        ['code_challenge_method', 'S256'],
        ...Object.entries(normalized.authorizationParameters),
        ['state', state],
      ];

      let callback: string;
      try {
        callback = await dependencies.redirect.launchAuthorization(
          `${normalized.issuer}/oauth/authorize?${formEncode(parameters)}`,
        );
      } catch (cause) {
        await dependencies.transactions.delete(normalized.providerId);
        throw new CodexExperimentalAuthError(
          'AUTHORIZATION_DENIED',
          'Browser authorization did not complete.',
          { cause },
        );
      }

      const transaction = await dependencies.transactions.take(normalized.providerId);
      if (transaction === undefined) {
        throw new CodexExperimentalAuthError(
          'INVALID_STATE',
          'Authorization transaction is missing or already consumed.',
        );
      }
      if (transaction.providerId !== normalized.providerId) {
        throw new CodexExperimentalAuthError(
          'INVALID_STATE',
          'Authorization transaction belongs to another provider.',
        );
      }
      const query = queryParameters(callbackQuery(callback, transaction.redirectUri));
      if (
        typeof query.state !== 'string' ||
        !constantTimeEqual(query.state, transaction.state) ||
        clock.now() - transaction.createdAt > transactionTtlMs
      ) {
        throw new CodexExperimentalAuthError(
          'INVALID_STATE',
          'Authorization state is invalid or expired.',
        );
      }
      if (query.error !== undefined) {
        throw new CodexExperimentalAuthError(
          'AUTHORIZATION_DENIED',
          'Authorization server rejected the request.',
        );
      }
      if (typeof query.code !== 'string' || query.code.length === 0) {
        throw new CodexExperimentalAuthError(
          'INVALID_CALLBACK',
          'OAuth callback omitted the authorization code.',
        );
      }
      return sendTokenRequest(
        {
          transport: dependencies.transport,
          clock,
          endpoint: `${normalized.issuer}/oauth/token`,
        },
        formEncode([
          ['grant_type', 'authorization_code'],
          ['code', query.code],
          ['redirect_uri', transaction.redirectUri],
          ['client_id', normalized.clientId],
          ['code_verifier', transaction.verifier],
        ]),
        'application/x-www-form-urlencoded',
        'authorization',
      );
    },
  });
}
