import type {
  CredentialProvider,
  StoredRefreshCredential,
} from '@mgravey/loom-credential-provider-api';

import type { CodexOAuthConfiguration, CodexOAuthDependencies } from './contracts.js';
import { normalizeConfiguration } from './configuration.js';
import { sendTokenRequest } from './token-endpoint.js';

const systemClock = Object.freeze({ now: Date.now });

export function createCodexExperimentalCredentialProvider(
  configuration: CodexOAuthConfiguration,
  dependencies: CodexOAuthDependencies,
): CredentialProvider {
  const normalized = normalizeConfiguration(configuration);
  const clock = dependencies.clock ?? systemClock;
  return Object.freeze({
    id: normalized.providerId,
    async refresh(credential: StoredRefreshCredential) {
      return sendTokenRequest(
        {
          transport: dependencies.transport,
          clock,
          endpoint: `${normalized.issuer}/oauth/token`,
        },
        JSON.stringify({
          client_id: normalized.clientId,
          grant_type: 'refresh_token',
          refresh_token: credential.value,
        }),
        'application/json',
        'refresh',
      );
    },
  });
}
