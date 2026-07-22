import type { ChromeStorageArea } from '@mgravey/loom-extension';
import { describe, expect, it } from 'vitest';

import {
  CODEX_CREDENTIAL_PERSISTENCE_KEY,
  CODEX_DEVICE_EXPERIMENT_ENABLED_KEY,
  createCodexExperimentSettings,
} from '../src/settings.js';

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

describe('Codex experiment settings', () => {
  it('is disabled by default and stores an explicit opt-in only in trusted storage', async () => {
    const storage = new MemoryStorage();
    const settings = createCodexExperimentSettings(storage);

    await expect(settings.isDeviceAuthorizationEnabled()).resolves.toBe(false);
    await settings.setDeviceAuthorizationEnabled(true);
    await expect(settings.isDeviceAuthorizationEnabled()).resolves.toBe(true);
    expect(storage.entries.get(CODEX_DEVICE_EXPERIMENT_ENABLED_KEY)).toBe(true);
    expect(storage.accessLevels).toEqual(['TRUSTED_CONTEXTS']);

    await settings.setDeviceAuthorizationEnabled(false);
    await expect(settings.isDeviceAuthorizationEnabled()).resolves.toBe(false);

    await expect(settings.getCredentialPersistenceMode()).resolves.toBe('session');
    await settings.setCredentialPersistenceMode('local');
    await expect(settings.getCredentialPersistenceMode()).resolves.toBe('local');
    expect(storage.entries.get(CODEX_CREDENTIAL_PERSISTENCE_KEY)).toBe('local');
  });
});
