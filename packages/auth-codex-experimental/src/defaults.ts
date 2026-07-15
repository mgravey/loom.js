export const CODEX_EXPERIMENTAL_PROVIDER_ID = 'openai/codex-experimental' as const;

/**
 * Audited implementation details from openai/codex commit 38b064c31b1f7464b281006316ec878ed23fea77.
 * These values are not a supported third-party OAuth contract.
 */
export const CODEX_CLI_OAUTH_AUDIT_SNAPSHOT = Object.freeze({
  sourceCommit: '38b064c31b1f7464b281006316ec878ed23fea77',
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scopes: Object.freeze([
    'openid',
    'profile',
    'email',
    'offline_access',
    'api.connectors.read',
    'api.connectors.invoke',
  ]),
  authorizationParameters: Object.freeze({
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  }),
  browserRedirectStatus: 'requires-provider-registration',
  deviceAuthorizationStatus: 'unsupported-experiment',
} as const);
