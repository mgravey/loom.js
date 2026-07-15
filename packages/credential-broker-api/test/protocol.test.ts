import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_BROKER_PROTOCOL,
  CREDENTIAL_BROKER_PROTOCOL_VERSION,
  CredentialBrokerError,
  createGetAccessTokenFailure,
  createGetAccessTokenRequest,
  createGetAccessTokenSuccess,
  credentialProviderId,
  isCredentialBrokerResponse,
  isCredentialProviderId,
  isGetAccessTokenRequest,
  parseCredentialBrokerResponse,
  parseGetAccessTokenRequest,
  type CredentialBroker,
} from '../src/index.js';

describe('credential provider IDs', () => {
  it('accepts provider-neutral namespaced IDs', () => {
    expect(credentialProviderId('example/mock')).toBe('example/mock');
    expect(isCredentialProviderId('local.test/provider-one')).toBe(true);
  });

  it.each(['', 'provider', 'Example/mock', 'example/', '/mock', 'example/mock/extra'])(
    'rejects invalid ID %j',
    (value) => {
      expect(isCredentialProviderId(value)).toBe(false);
      expect(() => credentialProviderId(value)).toThrow(TypeError);
    },
  );
});

describe('getAccessToken request protocol', () => {
  it('creates and parses an immutable JSON-safe request', () => {
    const request = createGetAccessTokenRequest('request-1', {
      providerId: credentialProviderId('example/mock'),
      sessionId: 'session-1',
    });
    const parsed = parseGetAccessTokenRequest(JSON.parse(JSON.stringify(request)) as unknown);

    expect(parsed).toEqual({
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: CREDENTIAL_BROKER_PROTOCOL_VERSION,
      type: 'getAccessToken',
      requestId: 'request-1',
      providerId: 'example/mock',
      sessionId: 'session-1',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(isGetAccessTokenRequest(parsed)).toBe(true);
  });

  it('omits an absent optional session ID', () => {
    const request = createGetAccessTokenRequest('request-2', {
      providerId: credentialProviderId('example/mock'),
    });
    expect(request).not.toHaveProperty('sessionId');
  });

  it.each([
    null,
    {},
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessToken',
      requestId: '',
      providerId: 'example/mock',
    },
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessToken',
      requestId: 'request',
      providerId: 'invalid',
    },
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessToken',
      requestId: 'request',
      providerId: 'example/mock',
      unexpected: true,
    },
  ])('rejects malformed request %#', (value) => {
    expect(isGetAccessTokenRequest(value)).toBe(false);
    expect(() => parseGetAccessTokenRequest(value)).toThrow(CredentialBrokerError);
  });

  it('distinguishes protocol version mismatches', () => {
    expect(() =>
      parseGetAccessTokenRequest({
        protocol: CREDENTIAL_BROKER_PROTOCOL,
        version: 2,
        type: 'getAccessToken',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialBrokerError>>({
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
      }),
    );
  });
});

describe('getAccessToken result protocol', () => {
  it('creates and parses an immutable success response', () => {
    const response = createGetAccessTokenSuccess('request-1', {
      accessToken: 'short-lived-token',
      expiresAt: 1_800_000_000_000,
    });
    const parsed = parseCredentialBrokerResponse(response);

    expect(parsed).toEqual({
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request-1',
      ok: true,
      accessToken: 'short-lived-token',
      expiresAt: 1_800_000_000_000,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(isCredentialBrokerResponse(parsed)).toBe(true);
  });

  it('creates and parses a deeply immutable failure response', () => {
    const response = createGetAccessTokenFailure('request-1', {
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Sign in before requesting a token.',
      retryable: false,
    });
    const parsed = parseCredentialBrokerResponse(response);

    expect(parsed).toEqual(response);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Object.isFrozen(parsed.error)).toBe(true);
    }
  });

  it.each([
    {},
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request',
      ok: true,
      accessToken: '',
    },
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request',
      ok: true,
      accessToken: 'token',
      expiresAt: -1,
    },
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request',
      ok: false,
      error: { code: 'SECRET_ERROR', message: 'no', retryable: false },
    },
    {
      protocol: CREDENTIAL_BROKER_PROTOCOL,
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request',
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '', retryable: false },
    },
  ])('rejects malformed response %#', (value) => {
    expect(isCredentialBrokerResponse(value)).toBe(false);
    expect(() => parseCredentialBrokerResponse(value)).toThrow(CredentialBrokerError);
  });

  it('supports transport-independent implementations', async () => {
    const broker: CredentialBroker = {
      getAccessToken: async ({ providerId }) => ({ accessToken: `token:${providerId}` }),
    };
    await expect(
      broker.getAccessToken({ providerId: credentialProviderId('example/mock') }),
    ).resolves.toEqual({ accessToken: 'token:example/mock' });
  });

  it('preserves typed broker error data without exposing transport details', () => {
    const cause = new Error('private cause');
    const error = new CredentialBrokerError('BROKER_UNAVAILABLE', 'Broker is unavailable.', {
      retryable: true,
      cause,
    });
    expect(error).toMatchObject({
      name: 'CredentialBrokerError',
      code: 'BROKER_UNAVAILABLE',
      retryable: true,
      cause,
    });
  });
});
