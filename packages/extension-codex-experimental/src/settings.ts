import type { ChromeStorageArea } from '@loom/extension';

export const CODEX_DEVICE_EXPERIMENT_ENABLED_KEY =
  'loom.codex-experimental.device-authorization-enabled' as const;

export interface CodexExperimentSettings {
  isDeviceAuthorizationEnabled(): Promise<boolean>;
  setDeviceAuthorizationEnabled(enabled: boolean): Promise<void>;
}

export function createCodexExperimentSettings(storage: ChromeStorageArea): CodexExperimentSettings {
  const ready = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return Object.freeze({
    async isDeviceAuthorizationEnabled() {
      await ready;
      const result = await storage.get(CODEX_DEVICE_EXPERIMENT_ENABLED_KEY);
      return result[CODEX_DEVICE_EXPERIMENT_ENABLED_KEY] === true;
    },
    async setDeviceAuthorizationEnabled(enabled: boolean) {
      await ready;
      await storage.set({ [CODEX_DEVICE_EXPERIMENT_ENABLED_KEY]: enabled });
    },
  });
}
