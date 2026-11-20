import { createOriginAuthorizer, type ChromeStorageArea } from '@mgravey/loom-extension';
import { describe, expect, it, vi } from 'vitest';
import {
  createResponsesConnectionStore,
  createResponsesConnectionListener,
  responsesEndpoint,
  responsesHostPattern,
  RESPONSES_CONNECTIONS_KEY,
} from '../src/responses-connections.js';

function memoryStorage(): ChromeStorageArea {
  const values: Record<string, unknown> = {};
  return {
    setAccessLevel: vi.fn(async () => undefined),
    get: async (key) => ({ [key]: values[key] }),
    set: async (entries) => {
      Object.assign(values, entries);
    },
    remove: async (key) => {
      Reflect.deleteProperty(values, key);
    },
  };
}
const profile = {
  id: 'ollama',
  label: 'My server',
  endpoint: 'http://localhost:11434/v1/responses',
  apiKey: 'extension-only-key',
};
const sender = { origin: 'https://studio.example', url: 'https://studio.example/workbench' };
const websiteApproval = createOriginAuthorizer(['https://studio.example']);
const permissions = () => ({ contains: vi.fn(async () => true), request: vi.fn(async () => true) });

describe('extension-owned Responses connections', () => {
  it('normalizes explicit HTTP(S) targets and derives Chrome host permission without a port', () => {
    expect(responsesEndpoint('http://localhost:11434')).toBe(profile.endpoint);
    expect(responsesEndpoint('http://localhost:11434/v1/')).toBe(profile.endpoint);
    expect(responsesEndpoint('https://custom.example/prefix/v1/')).toBe(
      'https://custom.example/prefix/v1/responses',
    );
    expect(responsesEndpoint('https://custom.example/prefix/v1/responses/')).toBe(
      'https://custom.example/prefix/v1/responses',
    );
    expect(responsesHostPattern(profile.endpoint)).toBe('http://localhost/*');
    for (const value of [
      'file:///v1/responses',
      'https://user:key@host/v1/responses',
      'https://host/v1/responses?key=secret',
      'https://host/v1/responses#secret',
      'https://host/admin',
    ])
      expect(() => responsesEndpoint(value)).toThrow();
  });
  it('stores keys in trusted extension storage and exposes only public metadata to an exact approved origin', async () => {
    const storage = memoryStorage();
    const store = createResponsesConnectionStore(storage, permissions(), websiteApproval);
    await store.save(profile);
    expect(storage.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect((await storage.get(RESPONSES_CONNECTIONS_KEY))[RESPONSES_CONNECTIONS_KEY]).toEqual([
      profile,
    ]);
    expect(JSON.stringify(await store.list())).not.toContain(profile.apiKey);
    const listener = createResponsesConnectionListener(store, { assertAuthorized: vi.fn() });
    const reply = await new Promise((resolve) =>
      listener(
        { protocol: 'loom/responses-connections', version: 1, type: 'get', connectionId: 'ollama' },
        sender,
        resolve,
      ),
    );
    expect(reply).toEqual({
      ok: true,
      connection: { id: 'ollama', label: 'My server', endpoint: profile.endpoint },
    });
    expect(JSON.stringify(reply)).not.toContain(profile.apiKey);
    for (const origin of [
      'https://studio.example.evil',
      'http://studio.example',
      'https://studio.example:1234',
    ])
      await expect(store.authorized('ollama', { origin, url: `${origin}/` })).rejects.toThrow();
    await store.remove('ollama');
    expect(JSON.stringify(await storage.get(RESPONSES_CONNECTIONS_KEY))).not.toContain(
      profile.apiKey,
    );
  });
  it('fails closed after host permission revocation and never moves a saved key to a replacement endpoint', async () => {
    const access = permissions();
    const store = createResponsesConnectionStore(memoryStorage(), access, websiteApproval);
    await store.save(profile);
    await store.save({ ...profile, endpoint: 'https://other.example/v1/responses', apiKey: '' });
    expect((await store.authorized('ollama', sender)).apiKey).toBe('');
    access.contains.mockResolvedValue(false);
    await expect(store.authorized('ollama', sender)).rejects.toThrow();
    await expect(store.save(profile)).rejects.toThrow();
  });
  it('does not provide a website configuration/write API or reveal keys on invalid messages', async () => {
    const store = createResponsesConnectionStore(memoryStorage(), permissions(), websiteApproval);
    await store.save(profile);
    const listener = createResponsesConnectionListener(store, { assertAuthorized: vi.fn() });
    for (const extra of [
      { type: 'set', apiKey: 'page-key' },
      { endpoint: 'https://evil.example/v1/responses' },
      { headers: { Authorization: 'anything' } },
    ]) {
      const reply = await new Promise((resolve) =>
        listener(
          {
            protocol: 'loom/responses-connections',
            version: 1,
            type: 'get',
            connectionId: 'ollama',
            ...extra,
          },
          sender,
          resolve,
        ),
      );
      expect(reply).toMatchObject({ ok: false });
      expect(JSON.stringify(reply)).not.toContain(profile.apiKey);
    }
    expect((await store.authorized('ollama', sender)).apiKey).toBe(profile.apiKey);
  });
  it('grants every current and future server through one website approval, ignores legacy per-server lists, and revokes all together', async () => {
    let approved = false;
    const authorizer = {
      assertAuthorized: vi.fn(() => {
        if (!approved) throw new Error('Website is not approved');
      }),
    };
    const store = createResponsesConnectionStore(memoryStorage(), permissions(), authorizer);
    const legacy = { ...profile, allowedOrigins: ['https://different.example'] };
    await store.save(legacy);
    await store.save({
      ...profile,
      id: 'second',
      endpoint: 'https://another.example/v1/responses',
    });
    await expect(store.authorized('ollama', sender)).rejects.toThrow();
    approved = true;
    for (const id of ['ollama', 'second'])
      await expect(store.authorized(id, sender)).resolves.toMatchObject({ id });
    await store.save({ ...profile, id: 'third' });
    await expect(store.authorized('third', sender)).resolves.toMatchObject({ id: 'third' });
    expect(JSON.stringify(await store.list())).not.toContain('allowedOrigins');
    approved = false;
    for (const id of ['ollama', 'second', 'third'])
      await expect(store.authorized(id, sender)).rejects.toThrow();
  });
});
