import type { CodexChromeExtensionApi, CodexModelFetch } from './chrome-contracts.js';
import type { ResponsesConnection } from './responses-connections.js';

export const GOOGLE_SUBSCRIPTION_ENDPOINT =
  'https://cloudcode-pa.googleapis.com/v1internal:generateContent';
export const GOOGLE_SUBSCRIPTION_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SESSION_KEY = 'loom.google-subscription.authorized';
const REVOCATION_KEY = SESSION_KEY + '.revocation';
export class GoogleSubscriptionError extends Error {
  constructor(
    readonly code:
      | 'NOT_CONFIGURED'
      | 'LOGIN_REQUIRED'
      | 'ACCESS_DENIED'
      | 'RATE_LIMITED'
      | 'PROVIDER_UNAVAILABLE'
      | 'UNSUPPORTED'
      | 'ACCOUNT_SETUP_REQUIRED'
      | 'INVALID_RESPONSE'
      | 'DEADLINE_EXCEEDED',
    readonly status?: number,
  ) {
    super(
      {
        NOT_CONFIGURED:
          'This experimental build needs a Loom-owned Google Chrome extension OAuth client.',
        LOGIN_REQUIRED: 'Sign in to Google from Companion settings.',
        ACCESS_DENIED:
          'Google did not grant this OAuth client Code Assist access. Subscription support is not verified for this client.',
        RATE_LIMITED: 'Google account access is rate limited. Wait before trying again.',
        PROVIDER_UNAVAILABLE: 'Google account access is temporarily unavailable. Try again later.',
        UNSUPPORTED:
          'The Code Assist account endpoint is unavailable for this client. No fallback billing route was used.',
        ACCOUNT_SETUP_REQUIRED:
          'Complete Gemini Code Assist setup using Google’s official client, or supply your eligible project ID.',
        INVALID_RESPONSE: 'Google returned an invalid Code Assist account response.',
        DEADLINE_EXCEEDED: 'Google account access check timed out. Try again.',
      }[code],
    );
    this.name = 'GoogleSubscriptionError';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function googleSubscriptionConfigured(chrome: CodexChromeExtensionApi): boolean {
  const manifest = chrome.runtime.getManifest?.();
  if (!record(manifest) || !record(manifest.oauth2)) return false;
  return (
    typeof manifest.oauth2.client_id === 'string' &&
    /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/u.test(manifest.oauth2.client_id) &&
    Array.isArray(manifest.oauth2.scopes) &&
    manifest.oauth2.scopes.includes(GOOGLE_SUBSCRIPTION_SCOPE) &&
    chrome.identity?.getAuthToken !== undefined
  );
}

/** Uses Chrome's OAuth cache. Tokens never enter profile storage or website messages. */
export function createGoogleSubscriptionAuth(
  chrome: CodexChromeExtensionApi,
  fetchRequest: CodexModelFetch,
) {
  const storage = chrome.storage.session;
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  async function revocation(): Promise<string> {
    const value = (await storage.get(REVOCATION_KEY))[REVOCATION_KEY];
    return typeof value === 'string' ? value : 'initial';
  }
  async function token(interactive: boolean): Promise<string> {
    if (!googleSubscriptionConfigured(chrome)) throw new GoogleSubscriptionError('NOT_CONFIGURED');
    let result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        chrome.identity?.getAuthToken?.({ interactive }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new GoogleSubscriptionError('DEADLINE_EXCEEDED')),
            interactive ? 120000 : 1500,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof GoogleSubscriptionError) throw error;
      throw new GoogleSubscriptionError('LOGIN_REQUIRED');
    } finally {
      clearTimeout(timer);
    }
    if (
      !result ||
      typeof result.token !== 'string' ||
      result.token.length === 0 ||
      result.token.length > 16384 ||
      (result.grantedScopes !== undefined &&
        !result.grantedScopes.includes(GOOGLE_SUBSCRIPTION_SCOPE))
    )
      throw new GoogleSubscriptionError('LOGIN_REQUIRED');
    return result.token;
  }
  return Object.freeze({
    async login(): Promise<void> {
      await ready;
      // Reuse Google's own account consent screen; no website can initiate this method.
      const epoch = await revocation();
      const marker = epoch + ':' + globalThis.crypto.randomUUID();
      await storage.set({ [SESSION_KEY]: 'pending:' + marker });
      try {
        await token(true);
        if ((await storage.get(SESSION_KEY))[SESSION_KEY] !== 'pending:' + marker)
          throw new GoogleSubscriptionError('LOGIN_REQUIRED');
        await storage.set({ [SESSION_KEY]: 'ready:' + marker });
        if ((await revocation()) !== epoch) throw new GoogleSubscriptionError('LOGIN_REQUIRED');
      } catch (error) {
        if ((await storage.get(SESSION_KEY))[SESSION_KEY] === 'pending:' + marker)
          await storage.remove(SESSION_KEY);
        throw error;
      }
    },
    async logout(): Promise<void> {
      await ready;
      // Revoke Loom's local authorization first, even if Chrome cache cleanup fails.
      await storage.set({ [REVOCATION_KEY]: globalThis.crypto.randomUUID() });
      await storage.remove(SESSION_KEY);
      await chrome.identity?.clearAllCachedAuthTokens?.();
    },
    async authorize(connection: ResponsesConnection): Promise<ResponsesConnection> {
      if (connection.provider !== 'gemini-subscription') return connection;
      await ready;
      const session = (await storage.get(SESSION_KEY))[SESSION_KEY];
      if (typeof session !== 'string' || !session.startsWith('ready:' + (await revocation()) + ':'))
        throw new GoogleSubscriptionError('LOGIN_REQUIRED');
      const accessToken = await token(false);
      const projectId = await checkGoogleSubscriptionAccess(
        connection.projectId,
        accessToken,
        fetchRequest,
      );
      // A logout while checking access must not resurrect the session.
      if (
        (await storage.get(SESSION_KEY))[SESSION_KEY] !== session ||
        !session.startsWith('ready:' + (await revocation()) + ':')
      )
        throw new GoogleSubscriptionError('LOGIN_REQUIRED');
      return Object.freeze({
        ...connection,
        endpoint: GOOGLE_SUBSCRIPTION_ENDPOINT,
        apiKey: accessToken,
        projectId,
      });
    },
  });
}

/** Read-only eligibility probe. Does not onboard, accept terms, or enable paid-credit overages. */
export async function checkGoogleSubscriptionAccess(
  projectId: string | undefined,
  token: string,
  fetchRequest: CodexModelFetch,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GoogleSubscriptionError('DEADLINE_EXCEEDED'));
    }, 6500);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchRequest(
          'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
          {
            method: 'POST',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              ...(projectId === undefined ? {} : { cloudaicompanionProject: projectId }),
              metadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
              },
            }),
          },
        );
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          throw new GoogleSubscriptionError(
            response.status === 401
              ? 'LOGIN_REQUIRED'
              : response.status === 429
                ? 'RATE_LIMITED'
                : response.status >= 500
                  ? 'PROVIDER_UNAVAILABLE'
                  : response.status === 404
                    ? 'UNSUPPORTED'
                    : 'ACCESS_DENIED',
            response.status,
          );
        }
        if (!response.body) throw new GoogleSubscriptionError('INVALID_RESPONSE');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let source = '',
          bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 65536) throw new GoogleSubscriptionError('INVALID_RESPONSE');
            source += decoder.decode(part.value, { stream: true });
          }
          source += decoder.decode();
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        let value: unknown;
        try {
          value = JSON.parse(source);
        } catch {
          throw new GoogleSubscriptionError('INVALID_RESPONSE');
        }
        if (!record(value)) throw new GoogleSubscriptionError('INVALID_RESPONSE');
        if (
          !record(value.currentTier) ||
          typeof value.currentTier.id !== 'string' ||
          !value.currentTier.id
        )
          throw new GoogleSubscriptionError('ACCOUNT_SETUP_REQUIRED');
        const project = value.cloudaicompanionProject ?? projectId;
        if (typeof project !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:._-]{2,199}$/u.test(project))
          throw new GoogleSubscriptionError('ACCOUNT_SETUP_REQUIRED');
        return project;
      })(),
    ]);
  } catch (error) {
    if (error instanceof GoogleSubscriptionError) throw error;
    throw new GoogleSubscriptionError('PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
