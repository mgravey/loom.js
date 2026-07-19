import { createOriginAuthorizer, type ChromeStorageArea } from '@loom/extension';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_ORIGIN_ACCESS_PROTOCOL,
  CODEX_ORIGIN_ACCESS_VERSION,
  createCodexOriginAccessListener,
  createCodexOriginAccessStore,
  createGrantedOriginAuthorizer,
} from '../src/origin-access.js';

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

function request(type: 'requestOriginAccess' | 'getOriginAccessStatus') {
  return {
    protocol: CODEX_ORIGIN_ACCESS_PROTOCOL,
    version: CODEX_ORIGIN_ACCESS_VERSION,
    type,
    requestId: `origin-${type}`,
  };
}

describe('Codex website-origin access', () => {
  it('stores durable exact-origin grants and session-only pending requests', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const store = createCodexOriginAccessStore({
      localStorage: local,
      sessionStorage: session,
    });
    await store.initialize();
    await store.request('https://loom.example');
    expect(await store.listPending()).toEqual(['https://loom.example']);
    expect(await store.listApproved()).toEqual([]);

    await store.approve('https://loom.example');
    expect(await store.listPending()).toEqual([]);
    expect(await store.listApproved()).toEqual(['https://loom.example']);
    expect(local.accessLevels).toContain('TRUSTED_CONTEXTS');
    expect(session.accessLevels).toContain('TRUSTED_CONTEXTS');

    const restarted = createCodexOriginAccessStore({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
    });
    await expect(restarted.isApproved('https://loom.example')).resolves.toBe(true);
    await restarted.revoke('https://loom.example');
    await expect(restarted.isApproved('https://loom.example')).resolves.toBe(false);
  });

  it('opens trusted extension UI for first contact and grants access only after approval', async () => {
    const store = createCodexOriginAccessStore({
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    const openOptionsPage = vi.fn(() => Promise.resolve());
    const manifestAuthorizer = createOriginAuthorizer(['http://localhost:4173']);
    const listener = createCodexOriginAccessListener({
      manifestAuthorizer,
      store,
      openOptionsPage,
    });
    const sender = {
      origin: 'http://localhost:4173',
      url: 'http://localhost:4173/workbench.html',
    };

    const pending = await new Promise<unknown>((resolve) => {
      listener(request('requestOriginAccess'), sender, resolve);
    });
    expect(pending).toMatchObject({ ok: true, approved: false });
    expect(openOptionsPage).toHaveBeenCalledOnce();
    await expect(store.listPending()).resolves.toEqual(['http://localhost:4173']);

    const authorizer = createGrantedOriginAuthorizer(manifestAuthorizer, store);
    await expect(authorizer.assertAuthorized(sender)).rejects.toMatchObject({
      code: 'UNAUTHORIZED_ORIGIN',
    });
    await store.approve('http://localhost:4173');
    await expect(authorizer.assertAuthorized(sender)).resolves.toBeUndefined();

    const approved = await new Promise<unknown>((resolve) => {
      listener(request('getOriginAccessStatus'), sender, resolve);
    });
    expect(approved).toMatchObject({ ok: true, approved: true });
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it('rejects origins outside the manifest before recording or opening approval UI', async () => {
    const store = createCodexOriginAccessStore({
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    });
    const openOptionsPage = vi.fn(() => Promise.resolve());
    const listener = createCodexOriginAccessListener({
      manifestAuthorizer: createOriginAuthorizer(['https://loom.example']),
      store,
      openOptionsPage,
    });
    const response = await new Promise<unknown>((resolve) => {
      listener(
        request('requestOriginAccess'),
        { origin: 'https://evil.example', url: 'https://evil.example/' },
        resolve,
      );
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED_REQUEST' },
    });
    await expect(store.listPending()).resolves.toEqual([]);
    expect(openOptionsPage).not.toHaveBeenCalled();
  });
});
