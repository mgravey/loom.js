import type { ChromeStorageArea } from '@loom/extension';

export const CODEX_ACCOUNT_ID_STORAGE_KEY = 'loom.codex-experimental.chatgpt-account-id' as const;

export interface CodexAccountRoutingStore {
  get(): Promise<string | undefined>;
  set(accountId: string): Promise<void>;
  delete(): Promise<void>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function validAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/u.test(value);
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
  const bytes = Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Extracts routing metadata only. The bearer token remains the authorization boundary. */
export function chatGptAccountIdFromIdToken(idToken: string): string {
  const payload = idToken.split('.')[1];
  if (payload === undefined || payload.length === 0) {
    throw new Error('The provider ID token does not contain routing metadata.');
  }
  let claims: Readonly<Record<string, unknown>> | undefined;
  try {
    claims = record(JSON.parse(decodeBase64Url(payload)));
  } catch {
    throw new Error('The provider ID token contains invalid routing metadata.');
  }
  const auth = record(claims?.['https://api.openai.com/auth']);
  const accountId = auth?.chatgpt_account_id;
  if (!validAccountId(accountId)) {
    throw new Error('The provider ID token is missing ChatGPT account routing metadata.');
  }
  return accountId;
}

export function createCodexAccountRoutingStore(
  storage: ChromeStorageArea,
): CodexAccountRoutingStore {
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return Object.freeze({
    async get() {
      await ready;
      const result = await storage.get(CODEX_ACCOUNT_ID_STORAGE_KEY);
      const value = result[CODEX_ACCOUNT_ID_STORAGE_KEY];
      return validAccountId(value) ? value : undefined;
    },
    async set(accountId: string) {
      await ready;
      if (!validAccountId(accountId)) {
        throw new TypeError('ChatGPT account ID must be a bounded routing identifier.');
      }
      await storage.set({ [CODEX_ACCOUNT_ID_STORAGE_KEY]: accountId });
    },
    async delete() {
      await ready;
      await storage.remove(CODEX_ACCOUNT_ID_STORAGE_KEY);
    },
  });
}
