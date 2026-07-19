import { createChromeRefreshCredentialStore, type ChromeStorageArea } from '@loom/extension';
import { describe, expect, it } from 'vitest';

import { createCodexAccountRoutingStore } from '../src/account-routing.js';
import { CODEX_EXPERIMENTAL_CONFIGURATION } from '../src/composition.js';
import { createCodexCredentialPersistence } from '../src/credential-persistence.js';
import { createCodexExperimentSettings } from '../src/settings.js';

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

function persistence(local: MemoryStorage, session: MemoryStorage) {
  const settings = createCodexExperimentSettings(local);
  return {
    settings,
    persistence: createCodexCredentialPersistence({
      settings,
      localStorage: local,
      sessionStorage: session,
      providerId: CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
    }),
  };
}

describe('Codex credential persistence', () => {
  it('defaults to session storage and migrates an authorization for browser restart opt-in', async () => {
    const local = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const first = persistence(local, firstSession);
    await first.persistence.initialize();
    await first.persistence.saveAuthorization(
      CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
      { value: 'private-refresh' },
      'account-one',
    );

    expect([...firstSession.entries.values()]).toEqual(
      expect.arrayContaining(['private-refresh', 'account-one']),
    );
    expect([...local.entries.values()]).not.toContain('private-refresh');

    await first.persistence.setMode('local');
    expect([...local.entries.values()]).toEqual(
      expect.arrayContaining(['local', 'private-refresh', 'account-one']),
    );
    expect([...firstSession.entries.values()]).not.toContain('private-refresh');

    const restartedSession = new MemoryStorage();
    const restarted = persistence(local, restartedSession);
    await restarted.persistence.initialize();
    await expect(restarted.persistence.getAuthorization()).resolves.toEqual({
      credential: { value: 'private-refresh' },
      accountId: 'account-one',
    });

    await restarted.persistence.setMode('session');
    expect([...local.entries.values()]).not.toContain('private-refresh');
    expect([...restartedSession.entries.values()]).toEqual(
      expect.arrayContaining(['private-refresh', 'account-one']),
    );
  });

  it('clears both storage areas and removes incomplete inactive state on initialization', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const localCredentials = createChromeRefreshCredentialStore(local);
    const localRouting = createCodexAccountRoutingStore(local);
    await localCredentials.set(CODEX_EXPERIMENTAL_CONFIGURATION.providerId, {
      value: 'orphaned-local-refresh',
    });

    const state = persistence(local, session);
    await state.persistence.initialize();
    expect([...local.entries.values()]).not.toContain('orphaned-local-refresh');

    await state.persistence.saveAuthorization(
      CODEX_EXPERIMENTAL_CONFIGURATION.providerId,
      { value: 'session-refresh' },
      'account-two',
    );
    await state.settings.setCredentialPersistenceMode('local');
    await localRouting.set('orphaned-routing');
    await state.persistence.clearAll(CODEX_EXPERIMENTAL_CONFIGURATION.providerId);

    expect([...local.entries.values()]).not.toEqual(
      expect.arrayContaining(['session-refresh', 'account-two', 'orphaned-routing']),
    );
    expect([...session.entries.values()]).not.toEqual(
      expect.arrayContaining(['session-refresh', 'account-two', 'orphaned-routing']),
    );
  });

  it('restricts persistent and session credentials to trusted extension contexts', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const state = persistence(local, session);
    await state.persistence.initialize();

    expect(local.accessLevels).not.toHaveLength(0);
    expect(session.accessLevels).not.toHaveLength(0);
    expect(local.accessLevels.every((level) => level === 'TRUSTED_CONTEXTS')).toBe(true);
    expect(session.accessLevels.every((level) => level === 'TRUSTED_CONTEXTS')).toBe(true);
  });
});
