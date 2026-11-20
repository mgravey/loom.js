import { describe, expect, it, vi } from 'vitest';
import {
  createResponsesConnectionListener,
  type ResponsesConnectionStore,
} from '../src/responses-connections.js';
import { discoverResponsesModels, type ResponsesModelsFetch } from '../src/responses-models.js';

const origin = { origin: 'https://studio.example', url: 'https://studio.example/' };
function fixture() {
  const profiles = ['local', 'remote', 'offline', 'private'].map((id) => ({
    id,
    label: id,
    apiKey: `${id}-secret`,
    endpoint: `https://${id}.example/proxy/v1/responses`,
    allowedOrigins: [origin.origin],
  }));
  const authorized = vi.fn(async (id: string) => {
    if (id === 'private') throw new Error('Not approved');
    const profile = profiles.find((p) => p.id === id);
    if (profile === undefined) throw new Error('Missing connection');
    return profile;
  });
  const store: ResponsesConnectionStore = {
    list: async () => profiles.map((p) => ({ ...p, hasApiKey: true })),
    authorized,
    save: vi.fn(),
    remove: vi.fn(),
  };
  const fetchRequest = vi.fn<ResponsesModelsFetch>(async (url) =>
    response(
      url.includes('offline')
        ? 'secret failure'
        : JSON.stringify({ data: [{ id: 'same/model:latest' }, { id: 'same/model:latest' }] }),
      url.includes('offline') ? 404 : 200,
    ),
  );
  return { store, fetchRequest, authorized };
}
function response(body: string, status = 200) {
  return {
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

describe('merged Responses catalogue', () => {
  it('fetches additions and removals afresh for every catalogue request', async () => {
    const { store, fetchRequest } = fixture();
    fetchRequest.mockImplementation(async () =>
      response(JSON.stringify({ data: [{ id: 'old' }] })),
    );
    expect((await discoverResponsesModels(store, origin, fetchRequest))[0]?.models).toEqual([
      'old',
    ]);
    fetchRequest.mockImplementation(async () =>
      response(JSON.stringify({ data: [{ id: 'new' }] })),
    );
    expect((await discoverResponsesModels(store, origin, fetchRequest))[0]?.models).toEqual([
      'new',
    ]);
    expect(fetchRequest).toHaveBeenCalledTimes(6);
  });
  it('discovers only approved servers, binds each key to its saved host and preserves partial successes', async () => {
    const { store, fetchRequest } = fixture();
    const result = await discoverResponsesModels(store, origin, fetchRequest);
    expect(result).toEqual([
      { id: 'local', label: 'local', models: ['same/model:latest'], unavailable: false },
      { id: 'remote', label: 'remote', models: ['same/model:latest'], unavailable: false },
      { id: 'offline', label: 'offline', models: [], unavailable: true },
    ]);
    expect(fetchRequest).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchRequest.mock.calls) {
      const id = new URL(url).hostname.split('.')[0];
      expect(url).toBe(`https://${id}.example/proxy/v1/models`);
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: `Bearer ${id}-secret` },
      });
      expect(init.headers).not.toHaveProperty('ChatGPT-Account-ID');
    }
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects URL/key overrides before discovery and reveals no profile without authorization', async () => {
    const { store, fetchRequest } = fixture();
    const authorizer = { assertAuthorized: vi.fn() };
    const listener = createResponsesConnectionListener(store, authorizer, fetchRequest);
    for (const extra of [
      { endpoint: 'https://evil.example/v1/models' },
      { connectionId: 'local' },
      { headers: {} },
    ]) {
      expect(
        await new Promise((resolve) =>
          listener(
            { protocol: 'loom/responses-connections', version: 1, type: 'catalogue', ...extra },
            origin,
            resolve,
          ),
        ),
      ).toMatchObject({ ok: false });
    }
    expect(fetchRequest).not.toHaveBeenCalled();
    authorizer.assertAuthorized.mockImplementation(() => {
      throw new Error('Denied');
    });
    expect(
      await new Promise((resolve) =>
        listener(
          { protocol: 'loom/responses-connections', version: 1, type: 'catalogue' },
          origin,
          resolve,
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(fetchRequest).not.toHaveBeenCalled();
  });
  it.each([
    '{',
    JSON.stringify({ data: [{ id: 'local-secret' }] }),
    JSON.stringify({ data: [{ id: '' }] }),
    'x'.repeat(256 * 1024 + 1),
  ])('bounds and validates provider catalogues without exposing malformed data', async (body) => {
    const { store, fetchRequest } = fixture();
    fetchRequest.mockImplementation(async () => response(body));
    const result = await discoverResponsesModels(store, origin, fetchRequest);
    expect(result[0]).toMatchObject({ unavailable: true, models: [] });
  });
  it('aborts stalled discovery at the deadline and retains other results', async () => {
    vi.useFakeTimers();
    try {
      const { store, fetchRequest } = fixture();
      let stalled: AbortSignal | undefined;
      fetchRequest.mockImplementation(async (url, init) => {
        if (url.includes('local')) {
          stalled = init.signal;
          return new Promise(() => undefined);
        }
        return response(JSON.stringify({ data: [{ id: 'ready' }] }));
      });
      const pending = discoverResponsesModels(store, origin, fetchRequest);
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;
      expect(stalled?.aborted).toBe(true);
      expect(result[0]).toMatchObject({ unavailable: true });
      expect(result[1]).toMatchObject({ models: ['ready'], unavailable: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
