import { createHash } from 'node:crypto';

import { CredentialProviderError } from '@loom/credential-provider-api';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_CLI_OAUTH_AUDIT_SNAPSHOT,
  CodexExperimentalAuthError,
  base64UrlEncode,
  createCodexExperimentalCredentialProvider,
  createCodexExperimentalDeviceAuthorization,
  createCodexExperimentalRedirectAuthorization,
  createCodexExperimentalRedirectAuthorizationRequest,
  completeCodexExperimentalRedirectAuthorization,
  type AuthorizationTransaction,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
} from '../src/index.js';

const configuration = Object.freeze({
  issuer: 'https://auth.example.test',
  clientId: 'public-client',
  providerId: 'test/codex',
  scopes: ['openid', 'offline_access'],
  authorizationParameters: {
    codex_cli_simplified_flow: 'true',
    originator: 'loom_test',
  },
  pollTimeoutMs: 10_000,
});

function sha256(input: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array(createHash('sha256').update(input).digest()));
}

function response(status: number, body: unknown): OAuthHttpResponse {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function queuedTransport(responses: readonly OAuthHttpResponse[]) {
  const queue = [...responses];
  const requests: OAuthHttpRequest[] = [];
  return {
    requests,
    transport: {
      send(request: OAuthHttpRequest): Promise<OAuthHttpResponse> {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error('Unexpected request');
        return Promise.resolve(next);
      },
    },
  };
}

describe('experimental Codex credential provider', () => {
  it('reproduces the audited JSON refresh request and refresh-token rotation', async () => {
    const fixture = queuedTransport([
      response(200, {
        access_token: 'short-lived-access',
        refresh_token: 'rotated-refresh',
        expires_in: 120,
      }),
    ]);
    const provider = createCodexExperimentalCredentialProvider(configuration, {
      transport: fixture.transport,
      clock: { now: () => 1_000 },
    });

    await expect(provider.refresh({ value: 'private-refresh' })).resolves.toEqual({
      accessToken: 'short-lived-access',
      expiresAt: 121_000,
      nextRefreshCredential: { value: 'rotated-refresh' },
    });
    expect(fixture.requests).toEqual([
      {
        method: 'POST',
        url: 'https://auth.example.test/oauth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: 'public-client',
          grant_type: 'refresh_token',
          refresh_token: 'private-refresh',
        }),
      },
    ]);
  });

  it('preserves the old refresh credential when rotation is omitted', async () => {
    const fixture = queuedTransport([
      response(200, { access_token: 'next-access', expires_in: 60 }),
    ]);
    const provider = createCodexExperimentalCredentialProvider(configuration, {
      transport: fixture.transport,
      clock: { now: () => 0 },
    });
    await expect(provider.refresh({ value: 'existing-refresh' })).resolves.toEqual({
      accessToken: 'next-access',
      expiresAt: 60_000,
    });
  });

  it('uses a JWT exp claim only as an access-token cache deadline', async () => {
    const payload = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ sub: 'not-trusted', exp: 90 })),
    );
    const fixture = queuedTransport([
      response(200, { access_token: `header.${payload}.signature` }),
    ]);
    const provider = createCodexExperimentalCredentialProvider(configuration, {
      transport: fixture.transport,
      clock: { now: () => 1_000 },
    });
    await expect(provider.refresh({ value: 'existing-refresh' })).resolves.toEqual({
      accessToken: `header.${payload}.signature`,
      expiresAt: 90_000,
    });
  });

  it.each([
    [401, { error: 'unknown' }],
    [400, { error: { code: 'refresh_token_expired' } }],
    [400, { code: 'refresh_token_reused' }],
    [400, { error: 'invalid_grant' }],
  ])('classifies permanent refresh rejection without leaking the body', async (status, body) => {
    const fixture = queuedTransport([response(status, body)]);
    const provider = createCodexExperimentalCredentialProvider(configuration, {
      transport: fixture.transport,
    });
    const failure = await provider
      .refresh({ value: 'private-refresh' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialProviderError);
    expect(failure).toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    expect((failure as Error).message).not.toContain('private-refresh');
  });

  it('sanitizes transport, malformed JSON, missing token, and transient HTTP failures', async () => {
    const thrown = createCodexExperimentalCredentialProvider(configuration, {
      transport: { send: vi.fn(() => Promise.reject(new Error('secret transport body'))) },
    });
    await expect(thrown.refresh({ value: 'secret' })).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      message: 'Token endpoint is unavailable.',
    });

    for (const endpointResponse of [
      response(200, 'not-json'),
      response(200, { expires_in: 60 }),
      response(503, { error: 'private-backend-detail' }),
    ]) {
      const fixture = queuedTransport([endpointResponse]);
      const provider = createCodexExperimentalCredentialProvider(configuration, {
        transport: fixture.transport,
      });
      const failure = await provider.refresh({ value: 'secret' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CredentialProviderError);
      expect((failure as Error).message).not.toContain('private-backend-detail');
    }
  });
});

describe('experimental Codex device authorization', () => {
  it('issues a user code, polls, validates server PKCE, and exchanges without a client secret', async () => {
    const verifier = base64UrlEncode(new Uint8Array(64).fill(7));
    const challenge = base64UrlEncode(await sha256(new TextEncoder().encode(verifier)));
    const fixture = queuedTransport([
      response(200, { device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: '2' }),
      response(403, { status: 'pending' }),
      response(200, {
        authorization_code: 'one-time-code',
        code_verifier: verifier,
        code_challenge: challenge,
      }),
      response(200, {
        id_token: 'private-id-token',
        access_token: 'short-lived-access',
        refresh_token: 'private-refresh',
        expires_in: 300,
      }),
    ]);
    let now = 10_000;
    const present = vi.fn(() => Promise.resolve());
    const authorization = createCodexExperimentalDeviceAuthorization(configuration, {
      transport: fixture.transport,
      digest: { digest: sha256 },
      clock: { now: () => now },
      delay: {
        wait(milliseconds) {
          now += milliseconds;
          return Promise.resolve();
        },
      },
      interaction: { present },
    });

    await expect(authorization.authorize()).resolves.toEqual({
      accessToken: 'short-lived-access',
      expiresAt: 312_000,
      nextRefreshCredential: { value: 'private-refresh' },
      idToken: 'private-id-token',
    });
    expect(present).toHaveBeenCalledWith({
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 20_000,
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      'https://auth.example.test/api/accounts/deviceauth/usercode',
      'https://auth.example.test/api/accounts/deviceauth/token',
      'https://auth.example.test/api/accounts/deviceauth/token',
      'https://auth.example.test/oauth/token',
    ]);
    const exchange = fixture.requests[3];
    expect(exchange?.body).toContain(
      'redirect_uri=https%3A%2F%2Fauth.example.test%2Fdeviceauth%2Fcallback',
    );
    expect(exchange?.body).toContain(`code_verifier=${verifier}`);
    expect(exchange?.body).not.toContain('client_secret');
  });

  it('reports disabled device auth, timeout, rejection, and malformed PKCE', async () => {
    const unavailable = queuedTransport([response(404, {})]);
    const unavailableAuth = createCodexExperimentalDeviceAuthorization(configuration, {
      transport: unavailable.transport,
      digest: { digest: sha256 },
      delay: { wait: vi.fn() },
      interaction: { present: vi.fn() },
    });
    await expect(unavailableAuth.authorize()).rejects.toMatchObject({
      code: 'DEVICE_AUTH_UNAVAILABLE',
    });

    let now = 0;
    const timeout = queuedTransport([
      response(200, { device_auth_id: 'id', usercode: 'CODE', interval: 1 }),
      response(403, {}),
    ]);
    const timeoutAuth = createCodexExperimentalDeviceAuthorization(
      { ...configuration, pollTimeoutMs: 1_000 },
      {
        transport: timeout.transport,
        digest: { digest: sha256 },
        clock: { now: () => now },
        delay: {
          wait: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
          },
        },
        interaction: { present: vi.fn() },
      },
    );
    await expect(timeoutAuth.authorize()).rejects.toMatchObject({ code: 'AUTHORIZATION_TIMEOUT' });

    const rejected = queuedTransport([
      response(200, { device_auth_id: 'id', user_code: 'CODE', interval: '1' }),
      response(400, { error: 'denied-and-private' }),
    ]);
    const rejectedAuth = createCodexExperimentalDeviceAuthorization(configuration, {
      transport: rejected.transport,
      digest: { digest: sha256 },
      delay: { wait: vi.fn() },
      interaction: { present: vi.fn() },
    });
    await expect(rejectedAuth.authorize()).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    const badPkce = queuedTransport([
      response(200, { device_auth_id: 'id', user_code: 'CODE', interval: '1' }),
      response(200, {
        authorization_code: 'code',
        code_verifier: base64UrlEncode(new Uint8Array(64)),
        code_challenge: 'inconsistent',
      }),
    ]);
    const badPkceAuth = createCodexExperimentalDeviceAuthorization(configuration, {
      transport: badPkce.transport,
      digest: { digest: sha256 },
      delay: { wait: vi.fn() },
      interaction: { present: vi.fn() },
    });
    await expect(badPkceAuth.authorize()).rejects.toMatchObject({ code: 'INVALID_PKCE' });
  });
});

describe('experimental direct redirect authorization', () => {
  function redirectFixture(options: { approved: boolean; state?: string }) {
    let stored: AuthorizationTransaction | undefined;
    const http = queuedTransport([
      response(200, {
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
      }),
    ]);
    const launchAuthorization = vi.fn((authorizationUrl: string) => {
      const url = new URL(authorizationUrl);
      const callbackState = options.state ?? url.searchParams.get('state') ?? '';
      return Promise.resolve(
        `https://extension-id.chromiumapp.org/codex?code=authorization-code&state=${callbackState}`,
      );
    });
    const authorization = createCodexExperimentalRedirectAuthorization(configuration, {
      transport: http.transport,
      digest: { digest: sha256 },
      random: { randomBytes: (length) => new Uint8Array(length).fill(9) },
      redirect: {
        getRedirectUri: () => 'https://extension-id.chromiumapp.org/codex',
        launchAuthorization,
      },
      transactions: {
        put(transaction) {
          stored = transaction;
          return Promise.resolve();
        },
        take() {
          const value = stored;
          stored = undefined;
          return Promise.resolve(value);
        },
        delete() {
          stored = undefined;
          return Promise.resolve();
        },
      },
      clock: { now: () => 1_000 },
      redirectRegistrationApproved: options.approved,
    });
    return { authorization, http, launchAuthorization, stored: () => stored };
  }

  it('is disabled until redirect registration is explicitly approved', async () => {
    const fixture = redirectFixture({ approved: false });
    await expect(fixture.authorization.authorize()).rejects.toMatchObject({
      code: 'EXPERIMENT_DISABLED',
    });
    expect(fixture.launchAuthorization).not.toHaveBeenCalled();
  });

  it('builds S256 authorization, consumes state, and exchanges the code', async () => {
    const fixture = redirectFixture({ approved: true });
    await expect(fixture.authorization.authorize()).resolves.toMatchObject({
      accessToken: 'access-token',
      nextRefreshCredential: { value: 'refresh-token' },
    });
    const authorizationUrl = new URL(String(fixture.launchAuthorization.mock.calls[0]?.[0]));
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid offline_access');
    expect(authorizationUrl.searchParams.get('originator')).toBe('loom_test');
    expect(fixture.stored()).toBeUndefined();
    expect(fixture.http.requests[0]?.body).not.toContain('client_secret');
  });

  it('rejects mismatched state and consumes the transaction', async () => {
    const fixture = redirectFixture({ approved: true, state: 'attacker-state' });
    await expect(fixture.authorization.authorize()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(fixture.stored()).toBeUndefined();
    expect(fixture.http.requests).toEqual([]);
  });

  it('resumes a loopback PKCE transaction once and rejects expired replay', async () => {
    let stored: AuthorizationTransaction | undefined;
    const transactions = {
      put(transaction: AuthorizationTransaction) {
        stored = transaction;
        return Promise.resolve();
      },
      take() {
        const value = stored;
        stored = undefined;
        return Promise.resolve(value);
      },
      delete() {
        stored = undefined;
        return Promise.resolve();
      },
    };
    const request = await createCodexExperimentalRedirectAuthorizationRequest(configuration, {
      digest: { digest: sha256 },
      random: { randomBytes: (length) => new Uint8Array(length).fill(4) },
      transactions,
      redirectUri: 'http://localhost:1455/auth/callback',
      clock: { now: () => 1_000 },
      redirectRegistrationApproved: true,
    });
    const state = new URL(request.authorizationUrl).searchParams.get('state');
    expect(new URL(request.authorizationUrl).searchParams.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    );
    const http = queuedTransport([]);
    await expect(
      completeCodexExperimentalRedirectAuthorization(
        configuration,
        `http://localhost:1455/auth/callback?code=x&state=${String(state)}`,
        {
          transport: http.transport,
          transactions,
          clock: { now: () => 601_001 },
          transactionTtlMs: 600_000,
          redirectRegistrationApproved: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(stored).toBeUndefined();
    await expect(
      completeCodexExperimentalRedirectAuthorization(
        configuration,
        `http://localhost:1455/auth/callback?code=x&state=${String(state)}`,
        {
          transport: http.transport,
          transactions,
          clock: { now: () => 1_001 },
          transactionTtlMs: 600_000,
          redirectRegistrationApproved: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(http.requests).toEqual([]);
  });
});

describe('experimental configuration and audit snapshot', () => {
  it('pins the audited source and rejects unsafe configuration', () => {
    expect(CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.sourceCommit).toBe(
      '38b064c31b1f7464b281006316ec878ed23fea77',
    );
    expect(CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.authorizationParameters.originator).toBe('codex_cli_rs');
    expect(() =>
      createCodexExperimentalCredentialProvider(
        { issuer: 'http://auth.example.test', clientId: 'client' },
        { transport: { send: vi.fn() } },
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      createCodexExperimentalRedirectAuthorization(
        {
          ...configuration,
          authorizationParameters: { state: 'override' },
        },
        {
          transport: { send: vi.fn() },
          digest: { digest: sha256 },
          random: { randomBytes: (length) => new Uint8Array(length) },
          redirect: { getRedirectUri: () => 'https://callback', launchAuthorization: vi.fn() },
          transactions: { put: vi.fn(), take: vi.fn(), delete: vi.fn() },
          redirectRegistrationApproved: true,
        },
      ),
    ).toThrow(/reserved/);
  });

  it('base64url-encodes without padding', () => {
    expect(base64UrlEncode(new Uint8Array([255, 254, 253, 252]))).toBe('__79_A');
  });

  it('uses sanitized typed experimental errors', () => {
    const error = new CodexExperimentalAuthError('EXPERIMENT_DISABLED', 'disabled');
    expect(error).toMatchObject({
      name: 'CodexExperimentalAuthError',
      code: 'EXPERIMENT_DISABLED',
    });
  });
});
