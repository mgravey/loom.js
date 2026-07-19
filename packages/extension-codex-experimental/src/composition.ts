import {
  CODEX_CLI_OAUTH_AUDIT_SNAPSHOT,
  CODEX_EXPERIMENTAL_PROVIDER_ID,
  createCodexExperimentalCredentialProvider,
  type CodexOAuthConfiguration,
} from '@loom/auth-codex-experimental';
import type { AccessTokenResult, StoredRefreshCredential } from '@loom/credential-provider-api';
import {
  createChromeExternalMessageListener,
  createCredentialBrokerMessageHandler,
  createExtensionTokenService,
  createOriginAuthorizer,
  ExtensionBrokerError,
  type ChromeExternalMessageListener,
  type ExtensionTokenService,
  type RefreshCredentialStore,
} from '@loom/extension';

import { createFetchOAuthTransport } from './adapters.js';
import type { CodexAccountRoutingStore } from './account-routing.js';
import type { CodexChromeExtensionApi, OAuthFetch } from './chrome-contracts.js';
import {
  createCodexCredentialPersistence,
  type CodexCredentialPersistence,
} from './credential-persistence.js';
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
  readonly accountRoutingStore: CodexAccountRoutingStore;
  readonly credentialPersistence: CodexCredentialPersistence;
  readonly settings: CodexExperimentSettings;
  readonly tokenService: ExtensionTokenService;
  readonly externalMessageListener: ChromeExternalMessageListener;
}

export function createCodexExperimentalExtension(
  options: CreateCodexExperimentalExtensionOptions,
): CodexExperimentalExtensionComposition {
  const settings = createCodexExperimentSettings(options.chromeApi.storage.local);
  const sessionStorage = options.chromeApi.storage.session;
  const credentialPersistence = createCodexCredentialPersistence({
    settings,
    localStorage: options.chromeApi.storage.local,
    sessionStorage,
    providerId: CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
  });
  const ready = credentialPersistence.initialize();
  const initializedStore: RefreshCredentialStore = Object.freeze({
    async get(providerId: string) {
      await ready;
      return credentialPersistence.credentialStore.get(providerId);
    },
    async set(providerId: string, credential: StoredRefreshCredential) {
      await ready;
      await credentialPersistence.credentialStore.set(providerId, credential);
    },
    async delete(providerId: string) {
      await ready;
      await credentialPersistence.credentialStore.delete(providerId);
    },
  });
  const accountRoutingStore: CodexAccountRoutingStore = Object.freeze({
    async get() {
      await ready;
      return credentialPersistence.accountRoutingStore.get();
    },
    async set(accountId: string) {
      await ready;
      await credentialPersistence.accountRoutingStore.set(accountId);
    },
    async delete() {
      await ready;
      await credentialPersistence.accountRoutingStore.delete();
    },
  });
  const initializedPersistence: CodexCredentialPersistence = Object.freeze({
    credentialStore: initializedStore,
    accountRoutingStore,
    initialize: () => ready,
    async getAuthorization() {
      await ready;
      return credentialPersistence.getAuthorization();
    },
    async saveAuthorization(
      providerId: string,
      credential: StoredRefreshCredential,
      accountId: string,
    ) {
      await ready;
      await credentialPersistence.saveAuthorization(providerId, credential, accountId);
    },
    async setMode(mode: Parameters<CodexCredentialPersistence['setMode']>[0]) {
      await ready;
      await credentialPersistence.setMode(mode);
    },
    async clearAll(providerId: string) {
      await ready;
      await credentialPersistence.clearAll(providerId);
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
        const [credential, accountId] = enabled
          ? await Promise.all([initializedStore.get(providerId), accountRoutingStore.get()])
          : [undefined, undefined];
        if (!enabled || credential === undefined || accountId === undefined) {
          tokenService.clearCachedAccessToken(providerId);
          if (credential === undefined) await accountRoutingStore.delete();
          throw new ExtensionBrokerError(
            'MISSING_CREDENTIAL',
            !enabled
              ? 'The experimental Codex credential provider is disabled.'
              : accountId === undefined
                ? 'The experimental Codex credential provider requires account routing authorization.'
                : 'The experimental Codex credential provider requires authorization.',
          );
        }
      }
      try {
        return await tokenService.getAccessToken(providerId);
      } catch (error) {
        if (
          providerId === provider.id &&
          error instanceof ExtensionBrokerError &&
          error.code === 'MISSING_CREDENTIAL'
        ) {
          await accountRoutingStore.delete();
        }
        throw error;
      }
    },
    acceptAuthorizationResult: (providerId: string, result: AccessTokenResult) =>
      tokenService.acceptAuthorizationResult(providerId, result),
    clearCachedAccessToken: (providerId: string) => tokenService.clearCachedAccessToken(providerId),
    async getStatus(providerId: string) {
      if (providerId === provider.id) {
        if (!(await settings.isDeviceAuthorizationEnabled())) {
          return Object.freeze({ authenticated: false });
        }
        const [status, accountId] = await Promise.all([
          tokenService.getStatus(providerId),
          accountRoutingStore.get(),
        ]);
        return Object.freeze({ authenticated: status.authenticated && accountId !== undefined });
      }
      return tokenService.getStatus(providerId);
    },
    async logout(providerId: string) {
      await tokenService.logout(providerId);
      if (providerId === provider.id) await accountRoutingStore.delete();
    },
  });
  const handler = createCredentialBrokerMessageHandler({
    authorizer: createOriginAuthorizer(options.allowedOrigins ?? DEVELOPMENT_ALLOWED_ORIGINS),
    tokenService: gatedTokenService,
    allowAccessTokenResponses: false,
  });

  return Object.freeze({
    providerId: provider.id,
    credentialStore: initializedStore,
    accountRoutingStore,
    credentialPersistence: initializedPersistence,
    settings,
    tokenService: gatedTokenService,
    externalMessageListener: createChromeExternalMessageListener(handler),
  });
}
