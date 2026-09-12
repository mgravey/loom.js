import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  clearLocalModelApiKey,
  loadLocalModelConnection,
  loadWorkbenchProvider,
  openAICompatibleBaseUrl,
  openAICompatibleEndpoint,
  openAICompatibleModelIds,
  saveLocalModelConnection,
  saveWorkbenchProvider,
  type KeyValueStorage,
} from '../src/local-model-connection.js';

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe('local model connection settings', () => {
  it('normalizes safe base URLs and derives fixed resources', () => {
    expect(openAICompatibleBaseUrl(' http://localhost:11434/v1/ ')).toBe(
      'http://localhost:11434/v1',
    );
    expect(openAICompatibleEndpoint('https://models.example.test/v1/', 'responses')).toBe(
      'https://models.example.test/v1/responses',
    );
    for (const value of [
      '',
      'relative/v1',
      'file:///v1',
      'http://user:password@localhost/v1',
      'http://localhost/v1?secret=yes',
      'http://localhost/v1#fragment',
    ]) {
      expect(() => openAICompatibleBaseUrl(value)).toThrow(TypeError);
    }
  });

  it('validates, bounds, and deduplicates discovered model IDs', () => {
    expect(
      openAICompatibleModelIds({
        data: [{ id: 'qwen3:8b' }, { id: 'qwen3:8b' }, { id: 'gpt-oss' }],
      }),
    ).toEqual(['qwen3:8b', 'gpt-oss']);
    expect(() => openAICompatibleModelIds({ data: [{ id: '' }] })).toThrow(TypeError);
    expect(() =>
      openAICompatibleModelIds({ data: Array.from({ length: 501 }, () => ({ id: 'x' })) }),
    ).toThrow(TypeError);
  });

  it('persists provider, endpoint, model, and API key and can clear the secret', () => {
    const storage = memoryStorage();
    expect(loadWorkbenchProvider(storage)).toBe('codex-experimental');
    expect(loadLocalModelConnection(storage)).toEqual({
      baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      model: '',
      apiKey: '',
    });

    saveWorkbenchProvider(storage, 'openai-compatible-responses');
    saveLocalModelConnection(storage, {
      baseUrl: 'http://192.168.1.5:1234/v1/',
      model: 'local-model',
      apiKey: 'private-key',
    });
    expect(loadWorkbenchProvider(storage)).toBe('openai-compatible-responses');
    expect(loadLocalModelConnection(storage)).toEqual({
      baseUrl: 'http://192.168.1.5:1234/v1',
      model: 'local-model',
      apiKey: 'private-key',
    });

    clearLocalModelApiKey(storage);
    expect(loadLocalModelConnection(storage).apiKey).toBe('');
  });
});
