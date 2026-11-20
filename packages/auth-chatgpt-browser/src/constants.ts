/** OpenAI's documented plan-usage management page ("Manage usage"). */
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
/** The documented loopback callback path. Only the port may vary between sign-ins. */
export const CHATGPT_BROWSER_DEFAULT_CALLBACK_PATH = '/auth/callback';
/** Default `postMessage` type used between the callback popup and the opener. */
export const CHATGPT_BROWSER_DEFAULT_MESSAGE_TYPE = 'loom/chatgpt-browser/callback';
/** Default Web Storage key prefix for non-secret registration and host metadata. */
export const CHATGPT_BROWSER_DEFAULT_STORAGE_PREFIX = 'loom.chatgpt-browser.';

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const AUTHORIZE_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/authorize`;
export const TOKEN_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
export const DISCOVERY_ENDPOINT = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

/** Validates a callback path: absolute, no query, fragment, traversal, or backslash. */
export function validCallbackPath(value: string): boolean {
  return (
    /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{0,200}$/u.test(value) &&
    !value.includes('//') &&
    !value.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** Validates a postMessage type: a short printable namespace string. */
export function validMessageType(value: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,128}$/u.test(value);
}
