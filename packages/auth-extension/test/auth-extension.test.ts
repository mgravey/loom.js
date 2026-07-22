import {
  CredentialBrokerError,
  createGetAccessTokenFailure,
  createGetAccessTokenSuccess,
  createGetCredentialStatusSuccess,
  createLogoutSuccess,
  credentialProviderId,
  type CredentialBroker,
  type GetAccessTokenRequest,
  type CredentialBrokerRequest,
} from '@mgravey/loom-credential-broker-api';
import {
  PLUGIN_API_VERSION,
  type AuthProvider,
  type PluginInitializeContext,
} from '@mgravey/loom-plugin-api';
import { describe, expect, it, vi } from 'vitest';

import {
  EXTENSION_AUTH_CAPABILITY_ID,
  EXTENSION_AUTH_KEY,
  EXTENSION_AUTH_PLUGIN_ID,
  ExtensionAuthError,
  createExtensionAuthPlugin,
  createExtensionAuthProvider,
  createExternalCredentialBroker,
  type ExternalMessageRuntime,
} from '../src/index.js';

const PROVIDER_ID = credentialProviderId('example/provider');

function broker(getAccessToken: CredentialBroker['getAccessToken']): CredentialBroker {
  return {
    getAccessToken,
    getStatus: async () => ({ authenticated: true }),
    logout: async () => undefined,
  };
}

describe('extension authentication provider', () => {
  it('adapts an explicit broker and exposes only the token string', async () => {
    const getAccessToken = vi.fn<CredentialBroker['getAccessToken']>(async () =>
      Object.freeze({ accessToken: 'temporary-access-token', expiresAt: 123_456 }),
    );
    const provider = createExtensionAuthProvider({
      broker: broker(getAccessToken),
      providerId: PROVIDER_ID,
    });

    await expect(provider.getAccessToken()).resolves.toBe('temporary-access-token');
    expect(getAccessToken).toHaveBeenCalledWith(Object.freeze({ providerId: PROVIDER_ID }));
    expect(Object.isFrozen(getAccessToken.mock.calls[0]?.[0])).toBe(true);
    expect(provider.configuration).toEqual({ providerId: PROVIDER_ID });
    expect(Object.isFrozen(provider.configuration)).toBe(true);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it('captures immutable configuration independently from the caller options', async () => {
    const firstGet = vi.fn<CredentialBroker['getAccessToken']>(async () => ({
      accessToken: 'one',
    }));
    const secondGet = vi.fn<CredentialBroker['getAccessToken']>(async () => ({
      accessToken: 'two',
    }));
    const options = {
      broker: broker(firstGet),
      providerId: 'example/provider',
    };
    const provider = createExtensionAuthProvider(options);
    options.broker = broker(secondGet);
    options.providerId = 'other/provider';

    await expect(provider.getAccessToken()).resolves.toBe('one');
    expect(firstGet).toHaveBeenCalledWith({ providerId: PROVIDER_ID });
    expect(secondGet).not.toHaveBeenCalled();
    expect(provider.configuration.providerId).toBe(PROVIDER_ID);
  });

  it('exposes status, authenticated, and logout without exposing credentials', async () => {
    const status = vi.fn<CredentialBroker['getStatus']>(async () => ({ authenticated: true }));
    const logout = vi.fn<CredentialBroker['logout']>(async () => undefined);
    const provider = createExtensionAuthProvider({
      broker: {
        getAccessToken: async () => ({ accessToken: 'temporary' }),
        getStatus: status,
        logout,
      },
      providerId: PROVIDER_ID,
    });

    await expect(provider.getStatus()).resolves.toEqual({ authenticated: true });
    await expect(provider.isAuthenticated()).resolves.toBe(true);
    await expect(provider.logout()).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledTimes(2);
    expect(logout).toHaveBeenCalledWith({ providerId: PROVIDER_ID });
    expect(JSON.stringify(await provider.getStatus())).not.toContain('accessToken');
  });

  it('maps structured broker failures without including credentials', async () => {
    const cause = new CredentialBrokerError(
      'AUTHENTICATION_REQUIRED',
      'Authentication is required.',
      { retryable: true },
    );
    const provider = createExtensionAuthProvider({
      broker: broker(async () => {
        throw cause;
      }),
      providerId: PROVIDER_ID,
    });

    const error = await provider.getAccessToken().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ExtensionAuthError);
    expect(error).toMatchObject({
      code: 'BROKER_REQUEST_FAILED',
      cause,
      details: {
        providerId: PROVIDER_ID,
        brokerCode: 'AUTHENTICATION_REQUIRED',
        retryable: true,
      },
    });
    expect(JSON.stringify(error)).not.toContain('accessToken');
  });

  it('maps unknown failures and malformed direct broker results', async () => {
    const unknownCause = new Error('connection failed');
    const failed = createExtensionAuthProvider({
      broker: broker(async () => {
        throw unknownCause;
      }),
      providerId: PROVIDER_ID,
    });
    await expect(failed.getAccessToken()).rejects.toMatchObject({
      code: 'BROKER_REQUEST_FAILED',
      cause: unknownCause,
      details: { providerId: PROVIDER_ID },
    });

    const malformed = createExtensionAuthProvider({
      broker: broker(async () => ({ accessToken: '' })),
      providerId: PROVIDER_ID,
    });
    await expect(malformed.getAccessToken()).rejects.toMatchObject({
      code: 'INVALID_BROKER_RESPONSE',
      details: { providerId: PROVIDER_ID },
    });
  });

  it('rejects missing brokers and invalid provider IDs eagerly', () => {
    expect(() => createExtensionAuthProvider(null as never)).toThrowError(ExtensionAuthError);
    expect(() =>
      createExtensionAuthProvider({ broker: {} as CredentialBroker, providerId: PROVIDER_ID }),
    ).toThrowError('An explicit credential broker is required.');
    expect(() =>
      createExtensionAuthProvider({
        broker: broker(async () => ({ accessToken: 'x' })),
        providerId: 'provider',
      }),
    ).toThrowError('A valid namespaced credential provider ID is required.');
  });
});

describe('extension authentication plugin', () => {
  it('exports stable identities and registers the provider during initialize', async () => {
    const plugin = createExtensionAuthPlugin({
      broker: broker(async () => ({ accessToken: 'token' })),
      providerId: PROVIDER_ID,
    });
    const register = vi.fn();

    await plugin.initialize?.({
      capabilities: { register },
    } as unknown as PluginInitializeContext);

    expect(plugin.manifest).toMatchObject({
      id: EXTENSION_AUTH_PLUGIN_ID,
      version: '0.1.0',
      apiVersion: PLUGIN_API_VERSION,
    });
    expect(EXTENSION_AUTH_CAPABILITY_ID).toBe('loom/extension-auth');
    expect(EXTENSION_AUTH_KEY).toEqual({ kind: 'auth', id: EXTENSION_AUTH_CAPABILITY_ID });
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toEqual(EXTENSION_AUTH_KEY);
    await expect((register.mock.calls[0]?.[1] as AuthProvider).getAccessToken()).resolves.toBe(
      'token',
    );
  });
});

describe('external-message credential broker', () => {
  it('uses a Promise-style injected runtime and validates immutable responses', async () => {
    const sendMessage = vi.fn(async (extensionId: string, message: unknown): Promise<unknown> => {
      expect(extensionId).toBe('extension-id');
      const request = message as GetAccessTokenRequest;
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.providerId).toBe(PROVIDER_ID);
      expect(request.sessionId).toBe('session-one');
      return createGetAccessTokenSuccess(request.requestId, {
        accessToken: 'short-lived-token',
        expiresAt: 999,
      });
    });
    const external = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: { sendMessage },
      requestIdFactory: () => 'request-one',
    });

    await expect(
      external.getAccessToken({ providerId: PROVIDER_ID, sessionId: 'session-one' }),
    ).resolves.toEqual({ accessToken: 'short-lived-token', expiresAt: 999 });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(Object.isFrozen(external.configuration)).toBe(true);
    expect(Object.isFrozen(external)).toBe(true);
  });

  it('supports callback-style runtimes without reading a Chrome global', async () => {
    const runtime: ExternalMessageRuntime = {
      sendMessage(_extensionId, message, _options, callback) {
        const request = message as GetAccessTokenRequest;
        queueMicrotask(() =>
          callback(
            createGetAccessTokenSuccess(request.requestId, {
              accessToken: 'callback-token',
            }),
          ),
        );
        return undefined;
      },
    };
    const external = createExternalCredentialBroker({ extensionId: 'extension-id', runtime });

    await expect(external.getAccessToken({ providerId: PROVIDER_ID })).resolves.toEqual({
      accessToken: 'callback-token',
    });
  });

  it('transports provider status and logout as credential-free operations', async () => {
    const sendMessage = vi.fn((_extensionId: string, message: unknown): Promise<unknown> => {
      const request = message as CredentialBrokerRequest;
      if (request.type === 'getCredentialStatus') {
        return Promise.resolve(
          createGetCredentialStatusSuccess(request.requestId, { authenticated: true }),
        );
      }
      if (request.type === 'logout') return Promise.resolve(createLogoutSuccess(request.requestId));
      return Promise.resolve(createGetAccessTokenSuccess(request.requestId, { accessToken: 'x' }));
    });
    const external = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: { sendMessage },
    });

    await expect(external.getStatus({ providerId: PROVIDER_ID })).resolves.toEqual({
      authenticated: true,
    });
    await expect(external.logout({ providerId: PROVIDER_ID })).resolves.toBeUndefined();
    expect(sendMessage.mock.calls.map((call) => (call[1] as CredentialBrokerRequest).type)).toEqual(
      ['getCredentialStatus', 'logout'],
    );
    expect(JSON.stringify(sendMessage.mock.calls)).not.toMatch(/accessToken|refreshToken/);
  });

  it('maps remote failure envelopes to structured broker errors', async () => {
    const external = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: {
        sendMessage(_extensionId, message) {
          const request = message as GetAccessTokenRequest;
          return Promise.resolve(
            createGetAccessTokenFailure(request.requestId, {
              code: 'TOKEN_REFRESH_FAILED',
              message: 'Refresh failed.',
              retryable: true,
            }),
          );
        },
      },
    });

    await expect(external.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      name: 'CredentialBrokerError',
      code: 'TOKEN_REFRESH_FAILED',
      retryable: true,
      message: 'Refresh failed.',
    });
  });

  it('rejects mismatched, malformed, and transport-failed responses', async () => {
    const mismatch = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: {
        sendMessage: () =>
          Promise.resolve(createGetAccessTokenSuccess('other-request', { accessToken: 'x' })),
      },
      requestIdFactory: () => 'expected-request',
    });
    await expect(mismatch.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });

    const malformed = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: { sendMessage: () => Promise.resolve({ accessToken: 'untrusted' }) },
    });
    await expect(malformed.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });

    const cause = new Error('extension unavailable');
    const failed = createExternalCredentialBroker({
      extensionId: 'extension-id',
      runtime: { sendMessage: () => Promise.reject(cause) },
    });
    await expect(failed.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
      retryable: true,
      cause,
    });
  });

  it('maps callback runtime.lastError and ignores a later duplicate completion', async () => {
    const runtime: {
      lastError?: { message: string };
      sendMessage: ExternalMessageRuntime['sendMessage'];
    } = {
      sendMessage(_extensionId, _message, _options, callback) {
        runtime.lastError = { message: 'No receiving end' };
        callback(undefined);
        delete runtime.lastError;
        return Promise.resolve(createGetAccessTokenSuccess('late', { accessToken: 'late-token' }));
      },
    };
    const external = createExternalCredentialBroker({ extensionId: 'extension-id', runtime });

    await expect(external.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('validates options and generated request IDs', async () => {
    expect(() => createExternalCredentialBroker(null as never)).toThrow(TypeError);
    expect(() =>
      createExternalCredentialBroker({ extensionId: '', runtime: { sendMessage: vi.fn() } }),
    ).toThrow('A non-empty extension ID is required.');
    expect(() =>
      createExternalCredentialBroker({ extensionId: 'id', runtime: {} as ExternalMessageRuntime }),
    ).toThrow('An explicit external-message runtime is required.');
    expect(() =>
      createExternalCredentialBroker({
        extensionId: 'id',
        runtime: { sendMessage: vi.fn() },
        requestIdFactory: 'invalid' as never,
      }),
    ).toThrow('requestIdFactory must be a function');

    const external = createExternalCredentialBroker({
      extensionId: 'id',
      runtime: { sendMessage: vi.fn() },
      requestIdFactory: () => '',
    });
    await expect(external.getAccessToken({ providerId: PROVIDER_ID })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});
