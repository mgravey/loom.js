import type {
  AccessTokenResult,
  ExtensionCredentialProvider,
  StoredRefreshCredential,
} from './contracts.js';

export interface CreateMockCredentialProviderOptions {
  readonly id?: string;
  readonly now?: () => number;
  readonly tokenLifetimeMs?: number;
}

export const MOCK_CREDENTIAL_PROVIDER_ID = 'loom/mock';

export function createMockCredentialProvider(
  options: CreateMockCredentialProviderOptions = {},
): ExtensionCredentialProvider {
  const id = options.id ?? MOCK_CREDENTIAL_PROVIDER_ID;
  const now = options.now ?? Date.now;
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 60_000;
  let generation = 0;

  return Object.freeze({
    id,
    refresh(credential: StoredRefreshCredential): Promise<AccessTokenResult> {
      if (credential.value.length === 0) throw new Error('The mock credential is empty.');
      generation += 1;
      return Promise.resolve(
        Object.freeze({
          accessToken: `mock-access-token-${String(generation)}`,
          expiresAt: now() + tokenLifetimeMs,
        }),
      );
    },
  });
}
