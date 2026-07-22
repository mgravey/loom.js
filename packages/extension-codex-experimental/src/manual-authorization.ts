import {
  createCodexExperimentalDeviceAuthorization,
  type DeviceAuthorizationPrompt,
} from '@mgravey/loom-auth-codex-experimental';
import {
  createBrowserDelay,
  createFetchOAuthTransport,
  createWebCryptoSha256Digest,
} from './adapters.js';
import { chatGptAccountIdFromIdToken } from './account-routing.js';
import type { BrowserCrypto, OAuthFetch } from './chrome-contracts.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from './composition.js';
import type { CodexCredentialPersistence } from './credential-persistence.js';
import type { CodexExperimentSettings } from './settings.js';

export interface ManualDeviceAuthorizationHost {
  readonly fetchRequest: OAuthFetch;
  readonly cryptoApi: BrowserCrypto;
  readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  presentChallenge(prompt: DeviceAuthorizationPrompt): Promise<void>;
}

export interface RunManualDeviceAuthorizationOptions {
  readonly settings: CodexExperimentSettings;
  readonly credentialPersistence: CodexCredentialPersistence;
  readonly host: ManualDeviceAuthorizationHost;
}

export async function runManualDeviceAuthorization(
  options: RunManualDeviceAuthorizationOptions,
): Promise<void> {
  if (!(await options.settings.isDeviceAuthorizationEnabled())) {
    throw new Error('The experimental device-code flow is disabled.');
  }
  const authorization = createCodexExperimentalDeviceAuthorization(
    CODEX_EXPERIMENTAL_CONFIGURATION,
    {
      transport: createFetchOAuthTransport(options.host.fetchRequest),
      digest: createWebCryptoSha256Digest(options.host.cryptoApi),
      delay: createBrowserDelay(options.host.schedule),
      interaction: Object.freeze({
        present: (prompt: DeviceAuthorizationPrompt) => options.host.presentChallenge(prompt),
      }),
    },
  );
  const result = await authorization.authorize();
  if (result.nextRefreshCredential === undefined) {
    throw new Error('Authorization completed without a refresh credential.');
  }
  if (!(await options.settings.isDeviceAuthorizationEnabled())) {
    throw new Error('The experimental device-code flow was disabled before completion.');
  }
  if (result.idToken === undefined) {
    throw new Error('Authorization completed without account routing metadata.');
  }
  const accountId = chatGptAccountIdFromIdToken(result.idToken);
  await options.credentialPersistence.saveAuthorization(
    authorization.providerId,
    result.nextRefreshCredential,
    accountId,
  );
}
