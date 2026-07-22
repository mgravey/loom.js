import type { ChromeStorageArea } from '@mgravey/loom-extension';
import { describe, expect, it } from 'vitest';

import {
  CODEX_ACCOUNT_ID_STORAGE_KEY,
  chatGptAccountIdFromIdToken,
  createCodexAccountRoutingStore,
} from '../src/account-routing.js';

class MemoryStorage implements ChromeStorageArea {
  readonly entries = new Map<string, unknown>();
  readonly accessLevels: string[] = [];

  setAccessLevel(options: { readonly accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    this.accessLevels.push(options.accessLevel);
    return Promise.resolve();
  }

  get(key: string): Promise<Record<string, unknown>> {
    return Promise.resolve({ [key]: this.entries.get(key) });
  }

  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.entries.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

function idToken(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

describe('Codex account routing metadata', () => {
  it('extracts the audited ChatGPT account claim without retaining the ID token', () => {
    expect(
      chatGptAccountIdFromIdToken(
        idToken({
          'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
        }),
      ),
    ).toBe('account-1');
    expect(() => chatGptAccountIdFromIdToken('invalid')).toThrow(/routing metadata/u);
    expect(() => chatGptAccountIdFromIdToken(idToken({ sub: 'user' }))).toThrow(
      /missing ChatGPT account/u,
    );
  });

  it('stores only the non-secret routing ID in trusted extension storage', async () => {
    const storage = new MemoryStorage();
    const store = createCodexAccountRoutingStore(storage);

    await expect(store.get()).resolves.toBeUndefined();
    await store.set('account-1');
    await expect(store.get()).resolves.toBe('account-1');
    expect(storage.entries).toEqual(new Map([[CODEX_ACCOUNT_ID_STORAGE_KEY, 'account-1']]));
    expect(storage.accessLevels).toEqual(['TRUSTED_CONTEXTS']);

    await store.delete();
    await expect(store.get()).resolves.toBeUndefined();
    await expect(store.set('bad\nheader')).rejects.toThrow(/bounded routing identifier/u);
  });
});
