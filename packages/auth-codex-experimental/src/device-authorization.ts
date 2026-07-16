import type {
  CodexInteractiveCredentialAuthorization,
  CodexDeviceAuthorizationDependencies,
  CodexOAuthConfiguration,
  OAuthClock,
  OAuthHttpResponse,
} from './contracts.js';
import { normalizeConfiguration } from './configuration.js';
import { asciiBytes, base64UrlEncode, constantTimeEqual, formEncode } from './encoding.js';
import { CodexExperimentalAuthError } from './errors.js';
import { sendTokenRequest } from './token-endpoint.js';

const systemClock: OAuthClock = Object.freeze({ now: Date.now });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(response: OAuthHttpResponse): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(response.body);
    if (isRecord(value)) return value;
  } catch {
    // Sanitized below.
  }
  throw new CodexExperimentalAuthError('INVALID_RESPONSE', 'Device endpoint response is invalid.');
}

async function postJson(
  dependencies: CodexDeviceAuthorizationDependencies,
  url: string,
  body: Readonly<Record<string, string>>,
): Promise<OAuthHttpResponse> {
  try {
    return await dependencies.transport.send({
      method: 'POST',
      url,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new CodexExperimentalAuthError(
      'TEMPORARY_FAILURE',
      'Device authorization endpoint is unavailable.',
      { cause },
    );
  }
}

export function createCodexExperimentalDeviceAuthorization(
  configuration: CodexOAuthConfiguration,
  dependencies: CodexDeviceAuthorizationDependencies,
): CodexInteractiveCredentialAuthorization {
  const normalized = normalizeConfiguration(configuration);
  const clock = dependencies.clock ?? systemClock;

  return Object.freeze({
    providerId: normalized.providerId,
    async authorize() {
      const issued = await postJson(
        dependencies,
        `${normalized.issuer}/api/accounts/deviceauth/usercode`,
        { client_id: normalized.clientId },
      );
      if (issued.status === 404) {
        throw new CodexExperimentalAuthError(
          'DEVICE_AUTH_UNAVAILABLE',
          'Device authorization is not enabled by the provider.',
        );
      }
      if (issued.status < 200 || issued.status >= 300) {
        throw new CodexExperimentalAuthError(
          'TEMPORARY_FAILURE',
          'Device authorization request failed.',
        );
      }
      const issuance = parseRecord(issued);
      const deviceAuthId = issuance.device_auth_id;
      const userCode = issuance.user_code ?? issuance.usercode;
      const intervalSeconds =
        typeof issuance.interval === 'string'
          ? Number(issuance.interval.trim())
          : issuance.interval;
      if (
        typeof deviceAuthId !== 'string' ||
        deviceAuthId.length === 0 ||
        typeof userCode !== 'string' ||
        userCode.length === 0 ||
        typeof intervalSeconds !== 'number' ||
        !Number.isFinite(intervalSeconds) ||
        intervalSeconds <= 0
      ) {
        throw new CodexExperimentalAuthError(
          'INVALID_RESPONSE',
          'Device authorization challenge is invalid.',
        );
      }
      const startedAt = clock.now();
      await dependencies.interaction.present(
        Object.freeze({
          verificationUrl: `${normalized.issuer}/codex/device`,
          userCode,
          expiresAt: startedAt + normalized.pollTimeoutMs,
        }),
      );

      let completed: Readonly<Record<string, unknown>> | undefined;
      while (clock.now() - startedAt < normalized.pollTimeoutMs) {
        const response = await postJson(
          dependencies,
          `${normalized.issuer}/api/accounts/deviceauth/token`,
          { device_auth_id: deviceAuthId, user_code: userCode },
        );
        if (response.status >= 200 && response.status < 300) {
          completed = parseRecord(response);
          break;
        }
        if (response.status !== 403 && response.status !== 404) {
          throw new CodexExperimentalAuthError(
            'AUTHORIZATION_DENIED',
            'Device authorization was rejected.',
          );
        }
        await dependencies.delay.wait(intervalSeconds * 1_000);
      }
      if (completed === undefined) {
        throw new CodexExperimentalAuthError(
          'AUTHORIZATION_TIMEOUT',
          'Device authorization timed out.',
        );
      }

      const authorizationCode = completed.authorization_code;
      const verifier = completed.code_verifier;
      const challenge = completed.code_challenge;
      if (
        typeof authorizationCode !== 'string' ||
        authorizationCode.length === 0 ||
        typeof verifier !== 'string' ||
        verifier.length < 43 ||
        verifier.length > 128 ||
        typeof challenge !== 'string' ||
        challenge.length === 0
      ) {
        throw new CodexExperimentalAuthError(
          'INVALID_RESPONSE',
          'Device authorization completion is invalid.',
        );
      }
      const expectedChallenge = base64UrlEncode(
        await dependencies.digest.digest(asciiBytes(verifier)),
      );
      if (!constantTimeEqual(expectedChallenge, challenge)) {
        throw new CodexExperimentalAuthError(
          'INVALID_PKCE',
          'Device authorization returned inconsistent PKCE data.',
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
          ['code', authorizationCode],
          ['redirect_uri', `${normalized.issuer}/deviceauth/callback`],
          ['client_id', normalized.clientId],
          ['code_verifier', verifier],
        ]),
        'application/x-www-form-urlencoded',
        'authorization',
      );
    },
  });
}
