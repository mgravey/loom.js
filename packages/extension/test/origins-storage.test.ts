import { describe, expect, it, vi } from 'vitest';

import {
  createChromeRefreshCredentialStore,
  createMemoryRefreshCredentialStore,
  createOriginAuthorizer,
  initializeTrustedCredentialStorage,
  restrictCredentialStorageToTrustedContexts,
  type ChromeStorageArea,
} from '../src/index.js';

describe('origin authorization', () => {
  it('accepts exact allowlisted sender origins and consistent URLs', () => {
    const authorizer = createOriginAuthorizer(['https://app.example', 'http://localhost:4173']);
    expect(() =>
      authorizer.assertAuthorized({
        origin: 'https://app.example',
        url: 'https://app.example/workspace',
      }),
    ).not.toThrow();
    expect(() =>
      authorizer.assertAuthorized({ url: 'http://localhost:4173/index.html' }),
    ).not.toThrow();
  });

  it('rejects untrusted, malformed, opaque, and inconsistent senders', () => {
    const authorizer = createOriginAuthorizer(['https://app.example']);
    for (const sender of [
      {},
      { origin: 'https://attacker.example' },
      { origin: 'not a url' },
      { origin: 'null' },
      { origin: 'https://app.example/path', url: 'https://app.example/page' },
      { origin: 'https://app.example', url: 'https://attacker.example/page' },
    ]) {
      expect(() => authorizer.assertAuthorized(sender)).toThrowError(
        expect.objectContaining({ code: 'UNAUTHORIZED_ORIGIN' }),
      );
    }
  });

  it('requires exact HTTP(S) origins in the configuration', () => {
    expect(() => createOriginAuthorizer([])).toThrow(TypeError);
    for (const origin of [
      'https://app.example/',
      'https://app.example/path',
      'ftp://app.example',
      'not a url',
      'https://user:password@app.example',
    ]) {
      expect(() => createOriginAuthorizer([origin])).toThrow(TypeError);
    }
  });
});

describe('refresh credential stores', () => {
  it('keeps in-memory credentials isolated behind the store contract', async () => {
    const store = createMemoryRefreshCredentialStore({ 'test/provider': 'first' });
    expect(await store.get('test/provider')).toEqual({ value: 'first' });
    await store.set('test/provider', { value: 'second' });
    expect(await store.get('test/provider')).toEqual({ value: 'second' });
    await store.delete('test/provider');
    expect(await store.get('test/provider')).toBeUndefined();
  });

  it('uses a namespaced Chrome storage key and ignores invalid values', async () => {
    const values = new Map<string, unknown>();
    const area: ChromeStorageArea = {
      setAccessLevel: vi.fn(async () => undefined),
      get: vi.fn(async (key) => ({ [key]: values.get(key) })),
      set: vi.fn(async (items) => {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      }),
      remove: vi.fn(async (key) => {
        values.delete(key);
      }),
    };
    const store = createChromeRefreshCredentialStore(area);

    await restrictCredentialStorageToTrustedContexts(area);
    expect(area.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });

    expect(await store.get('test/provider')).toBeUndefined();
    await store.set('test/provider', { value: 'private-value' });
    expect(await store.get('test/provider')).toEqual({ value: 'private-value' });
    expect(area.set).toHaveBeenCalledWith({
      'loom.refresh-credential.test%2Fprovider': 'private-value',
    });
    await store.delete('test/provider');
    expect(await store.get('test/provider')).toBeUndefined();

    values.set('loom.refresh-credential.test%2Fprovider', 42);
    expect(await store.get('test/provider')).toBeUndefined();
    values.set('loom.refresh-credential.test%2Fprovider', '');
    expect(await store.get('test/provider')).toBeUndefined();
  });

  it('restricts Chrome storage before credential initialization', async () => {
    const order: string[] = [];
    const area: ChromeStorageArea = {
      setAccessLevel: vi.fn(async () => {
        order.push('restrict');
      }),
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await initializeTrustedCredentialStorage(area, async () => {
      order.push('initialize');
    });

    expect(order).toEqual(['restrict', 'initialize']);
  });
});
