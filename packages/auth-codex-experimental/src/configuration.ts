import type { CodexOAuthConfiguration } from './contracts.js';
import { CODEX_EXPERIMENTAL_PROVIDER_ID } from './defaults.js';

const NAMESPACED_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export interface NormalizedCodexOAuthConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly providerId: string;
  readonly scopes: readonly string[];
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly pollTimeoutMs: number;
}

function assertIssuer(value: string): void {
  const secure = /^https:\/\/[^/?#]+(?:\/[^?#]*)?$/u.test(value);
  const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^?#]*)?$/u.test(value);
  if (!secure && !loopback) {
    throw new TypeError('OAuth issuer must use HTTPS or a loopback HTTP origin for tests.');
  }
}

export function normalizeConfiguration(
  configuration: CodexOAuthConfiguration,
): NormalizedCodexOAuthConfiguration {
  const issuer = configuration.issuer.replace(/\/+$/u, '');
  assertIssuer(issuer);
  if (configuration.clientId.length === 0) throw new TypeError('OAuth client ID is required.');
  const providerId = configuration.providerId ?? CODEX_EXPERIMENTAL_PROVIDER_ID;
  if (!NAMESPACED_ID.test(providerId)) throw new TypeError('Provider ID must be namespaced.');
  const scopes = [...(configuration.scopes ?? [])];
  if (scopes.some((scope) => scope.length === 0 || /\s/u.test(scope))) {
    throw new TypeError('OAuth scopes must be non-empty tokens.');
  }
  const authorizationParameters = { ...(configuration.authorizationParameters ?? {}) };
  for (const [key, value] of Object.entries(authorizationParameters)) {
    if (key.length === 0 || value.length === 0) {
      throw new TypeError('OAuth authorization parameters must be non-empty.');
    }
  }
  const pollTimeoutMs = configuration.pollTimeoutMs ?? 15 * 60 * 1_000;
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs <= 0) {
    throw new RangeError('Device authorization timeout must be positive and finite.');
  }
  return Object.freeze({
    issuer,
    clientId: configuration.clientId,
    providerId,
    scopes: Object.freeze(scopes),
    authorizationParameters: Object.freeze(authorizationParameters),
    pollTimeoutMs,
  });
}
