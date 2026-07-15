import {
  CODEX_CLI_OAUTH_AUDIT_SNAPSHOT,
  CODEX_EXPERIMENTAL_PROVIDER_ID,
  createCodexExperimentalCredentialProvider,
  type CodexOAuthConfiguration,
} from '@loom/auth-codex-experimental';
import type { AccessTokenResult, StoredRefreshCredential } from '@loom/credential-provider-api';
import {
  createChromeExternalMessageListener,
  createChromeRefreshCredentialStore,
  createCredentialBrokerMessageHandler,
  createExtensionTokenService,
  createOriginAuthorizer,
  ExtensionBrokerError,
  initializeTrustedCredentialStorage,
  type ChromeExternalMessageListener,
  type ExtensionTokenService,
  type RefreshCredentialStore,
} from '@loom/extension';

import { createFetchOAuthTransport } from './adapters.js';
import type { CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';
import { createCodexExperimentSettings, type CodexExperimentSettings } from './settings.js';

export const CODEX_EXPERIMENTAL_CONFIGURATION = Object.freeze({
  issuer: CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.issuer,
  clientId: CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.clientId,
  providerId: CODEX_EXPERIMENTAL_PROVIDER_ID,
  scopes: CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.scopes,
  authorizationParameters: Object.freeze({
    ...CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.authorizationParameters,
    // Identify this as Loom's experiment rather than impersonating the CLI host.
    originator: 'loom_extension_experiment',
  }),
} satisfies CodexOAuthConfiguration);

export const DEVELOPMENT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:4173',
  'http://127.0.0.1:4173',
] as const);

export interface CreateCodexExperimentalExtensionOptions {
  readonly chromeApi: CodexChromeExtensionApi;
  readonly fetchRequest: OAuthFetch;
  readonly allowedOrigins?: readonly string[];
}

export interface CodexExperimentalExtensionComposition {
  readonly providerId: string;
  readonly credentialStore: RefreshCredentialStore;
  readonly settings: CodexExperimentSettings;
  readonly tokenService: ExtensionTokenService;
  readonly externalMessageListener: ChromeExternalMessageListener;
}

export function createCodexExperimentalExtension(
  options: CreateCodexExperimentalExtensionOptions,
): CodexExperimentalExtensionComposition {
  const storage = options.chromeApi.storage.local;
  const settings = createCodexExperimentSettings(storage);
  const credentialStore = createChromeRefreshCredentialStore(storage);
  const ready = initializeTrustedCredentialStorage(storage, () => Promise.resolve());
  const initializedStore: RefreshCredentialStore = Object.freeze({
    async get(providerId: string) {
      await ready;
      return credentialStore.get(providerId);
    },
    async set(providerId: string, credential: StoredRefreshCredential) {
      await ready;
      await credentialStore.set(providerId, credential);
    },
    async delete(providerId: string) {
      await ready;
      await credentialStore.delete(providerId);
    },
  });
  const provider = createCodexExperimentalCredentialProvider(CODEX_EXPERIMENTAL_CONFIGURATION, {
    transport: createFetchOAuthTransport(
      options.fetchRequest,
      CODEX_CLI_OAUTH_AUDIT_SNAPSHOT.issuer,
    ),
  });
  const tokenService = createExtensionTokenService({
    providers: [provider],
    credentialStore: initializedStore,
  });
  const gatedTokenService: ExtensionTokenService = Object.freeze({
    async getAccessToken(providerId: string) {
      if (providerId === provider.id) {
        const enabled = await settings.isDeviceAuthorizationEnabled();
        const credential = enabled ? await initializedStore.get(providerId) : undefined;
        if (!enabled || credential === undefined) {
          tokenService.clearCachedAccessToken(providerId);
          throw new ExtensionBrokerError(
            'MISSING_CREDENTIAL',
            enabled
              ? 'The experimental Codex credential provider requires authorization.'
              : 'The experimental Codex credential provider is disabled.',
          );
        }
      }
      return tokenService.getAccessToken(providerId);
    },
    acceptAuthorizationResult: (providerId: string, result: AccessTokenResult) =>
      tokenService.acceptAuthorizationResult(providerId, result),
    clearCachedAccessToken: (providerId: string) => tokenService.clearCachedAccessToken(providerId),
  });
  const handler = createCredentialBrokerMessageHandler({
    authorizer: createOriginAuthorizer(options.allowedOrigins ?? DEVELOPMENT_ALLOWED_ORIGINS),
    tokenService: gatedTokenService,
  });

  return Object.freeze({
    providerId: provider.id,
    credentialStore: initializedStore,
    settings,
    tokenService: gatedTokenService,
    externalMessageListener: createChromeExternalMessageListener(handler),
  });
}
