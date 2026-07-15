import {
  createGetAccessTokenRequest,
  credentialProviderId,
  parseCredentialBrokerResponse,
} from '@loom/credential-broker-api';
import { describe, expect, it, vi } from 'vitest';

import {
  createChromeExternalMessageListener,
  createCredentialBrokerMessageHandler,
  createExtensionTokenService,
  createMemoryRefreshCredentialStore,
  createMockCredentialProvider,
  createOriginAuthorizer,
} from '../src/index.js';

const providerId = credentialProviderId('loom/mock');
const request = createGetAccessTokenRequest('request-1', {
  providerId,
  sessionId: 'session-1',
});

function createHandler() {
  const store = createMemoryRefreshCredentialStore({ [providerId]: 'private-refresh-value' });
  const provider = createMockCredentialProvider({
    id: providerId,
    now: () => 1_000,
    tokenLifetimeMs: 60_000,
  });
  return createCredentialBrokerMessageHandler({
    authorizer: createOriginAuthorizer(['https://app.example']),
    tokenService: createExtensionTokenService({
      providers: [provider],
      credentialStore: store,
      clock: { now: () => 1_000 },
    }),
  });
}

describe('credential broker message handler', () => {
  it('returns a protocol-valid access token only to an authorized origin', async () => {
    const response = await createHandler().handle(request, {
      origin: 'https://app.example',
      url: 'https://app.example/workspace',
    });

    expect(parseCredentialBrokerResponse(response)).toEqual({
      protocol: 'loom/credential-broker',
      version: 1,
      type: 'getAccessTokenResult',
      requestId: 'request-1',
      ok: true,
      accessToken: 'mock-access-token-1',
      expiresAt: 61_000,
    });
    expect(JSON.stringify(response)).not.toContain('private-refresh-value');
  });

  it('rejects unauthorized senders before handling a valid request', async () => {
    await expect(
      createHandler().handle(request, { origin: 'https://attacker.example' }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      ok: false,
      error: { code: 'UNAUTHORIZED_REQUEST', retryable: false },
    });
  });

  it('maps malformed requests, unsupported versions, and provider failures', async () => {
    const handler = createHandler();
    await expect(
      handler.handle({ requestId: 'malformed-1' }, { origin: 'https://app.example' }),
    ).resolves.toMatchObject({
      requestId: 'malformed-1',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    await expect(
      handler.handle(
        { ...request, version: 99, requestId: 'version-1' },
        { origin: 'https://app.example' },
      ),
    ).resolves.toMatchObject({
      requestId: 'version-1',
      ok: false,
      error: { code: 'UNSUPPORTED_PROTOCOL_VERSION' },
    });
    await expect(
      handler.handle(
        { ...request, providerId: credentialProviderId('loom/missing') },
        { origin: 'https://app.example' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_NOT_FOUND' },
    });
  });

  it('uses a safe fallback request ID for non-object messages', async () => {
    await expect(
      createHandler().handle(null, { origin: 'https://app.example' }),
    ).resolves.toMatchObject({
      requestId: 'invalid-request',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('keeps the Chrome response channel open and answers asynchronously', async () => {
    const listener = createChromeExternalMessageListener(createHandler());
    const sendResponse = vi.fn();

    expect(listener(request, { origin: 'https://app.example' }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-1', ok: true }),
    );
  });
});
