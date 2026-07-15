import { describe, expect, it } from 'vitest';

import {
  CredentialProviderError,
  isCredentialProviderError,
  type CredentialProvider,
  type InteractiveCredentialAuthorization,
} from '../src/index.js';

describe('credential provider contracts', () => {
  it('exposes host-neutral refresh and authorization contracts', async () => {
    const provider: CredentialProvider = {
      id: 'test/provider',
      refresh: async () => ({ accessToken: 'access', expiresAt: 2_000 }),
    };
    const authorization: InteractiveCredentialAuthorization = {
      providerId: provider.id,
      authorize: async () => ({
        accessToken: 'authorized',
        expiresAt: 3_000,
        nextRefreshCredential: { value: 'refresh' },
      }),
    };

    await expect(provider.refresh({ value: 'refresh' })).resolves.toEqual({
      accessToken: 'access',
      expiresAt: 2_000,
    });
    await expect(authorization.authorize()).resolves.toMatchObject({
      accessToken: 'authorized',
    });
  });

  it.each(['CREDENTIAL_REJECTED', 'TEMPORARY_FAILURE', 'INVALID_RESPONSE'] as const)(
    'provides an inspectable %s error',
    (code) => {
      const cause = new Error('provider detail');
      const error = new CredentialProviderError(code, 'Sanitized provider failure.', { cause });

      expect(error).toMatchObject({ name: 'CredentialProviderError', code, cause });
      expect(isCredentialProviderError(error)).toBe(true);
      expect(
        isCredentialProviderError({ name: 'CredentialProviderError', code, message: 'copied' }),
      ).toBe(true);
    },
  );

  it('rejects unrelated and unknown error shapes', () => {
    expect(isCredentialProviderError(new Error('ordinary'))).toBe(false);
    expect(isCredentialProviderError({ name: 'CredentialProviderError', code: 'UNKNOWN' })).toBe(
      false,
    );
    expect(isCredentialProviderError(null)).toBe(false);
  });
});
