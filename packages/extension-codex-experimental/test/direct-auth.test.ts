import type { ExtensionTokenService, OriginAuthorizer } from '@mgravey/loom-extension';
import { describe, expect, it, vi } from 'vitest';

import type { CodexAccountRoutingStore } from '../src/account-routing.js';
import {
  CODEX_DIRECT_AUTH_PROTOCOL,
  CODEX_DIRECT_AUTH_VERSION,
  createCodexDirectAuthListener,
} from '../src/direct-auth.js';

function request() {
  return {
    protocol: CODEX_DIRECT_AUTH_PROTOCOL,
    version: CODEX_DIRECT_AUTH_VERSION,
    type: 'getDirectCredentials',
    requestId: 'direct-1',
    providerId: 'openai/codex-experimental',
  };
}

describe('Codex direct browser authentication bridge', () => {
  it('returns only a short-lived access token and account routing to an authorized page', async () => {
    const authorizer: OriginAuthorizer = {
      assertAuthorized: vi.fn(),
    };
    const tokenService = {
      getAccessToken: vi.fn(() =>
        Promise.resolve({ accessToken: 'short-lived-access', expiresAt: 123_456 }),
      ),
    } as unknown as ExtensionTokenService;
    const accountRoutingStore = {
      get: vi.fn(() => Promise.resolve('account-1')),
    } as unknown as CodexAccountRoutingStore;
    const listener = createCodexDirectAuthListener({
      providerId: 'openai/codex-experimental',
      authorizer,
      tokenService,
      accountRoutingStore,
    });

    const response = await new Promise<unknown>((resolve) => {
      listener(
        request(),
        { origin: 'http://localhost:4173', url: 'http://localhost:4173/workbench.html' },
        resolve,
      );
    });

    expect(authorizer.assertAuthorized).toHaveBeenCalledOnce();
    expect(response).toEqual({
      protocol: CODEX_DIRECT_AUTH_PROTOCOL,
      version: CODEX_DIRECT_AUTH_VERSION,
      type: 'getDirectCredentialsResult',
      requestId: 'direct-1',
      ok: true,
      accessToken: 'short-lived-access',
      accountId: 'account-1',
      expiresAt: 123_456,
    });
  });

  it('does not request a token when account routing is unavailable', async () => {
    const tokenService = {
      getAccessToken: vi.fn(),
    } as unknown as ExtensionTokenService;
    const listener = createCodexDirectAuthListener({
      providerId: 'openai/codex-experimental',
      authorizer: { assertAuthorized: vi.fn() },
      tokenService,
      accountRoutingStore: {
        get: vi.fn(() => Promise.resolve(undefined)),
      } as unknown as CodexAccountRoutingStore,
    });

    const response = await new Promise<unknown>((resolve) => {
      listener(request(), { origin: 'http://localhost:4173' }, resolve);
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(tokenService.getAccessToken).not.toHaveBeenCalled();
  });
});
