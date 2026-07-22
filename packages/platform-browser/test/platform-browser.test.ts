import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_PLATFORM_CAPABILITY_ID,
  BROWSER_PLATFORM_KEY,
  BROWSER_PLATFORM_PLUGIN_ID,
  createBrowserPlatformPlugin,
  type BrowserPlatform,
  type CreateBrowserPlatformPluginOptions,
} from '../src/index.js';
import {
  PLUGIN_API_VERSION,
  type CapabilityKey,
  type PluginInitializeContext,
} from '@mgravey/loom-plugin-api';
import { systemClock } from '@mgravey/loom-types';

function fakeIdbFactory(label: string): IDBFactory {
  return Object.freeze({ label }) as unknown as IDBFactory;
}

async function initialize(options: CreateBrowserPlatformPluginOptions): Promise<{
  readonly plugin: ReturnType<typeof createBrowserPlatformPlugin>;
  readonly registrations: readonly {
    readonly key: CapabilityKey<BrowserPlatform>;
    readonly platform: BrowserPlatform;
  }[];
}> {
  const plugin = createBrowserPlatformPlugin(options);
  const registrations: {
    key: CapabilityKey<BrowserPlatform>;
    platform: BrowserPlatform;
  }[] = [];

  await plugin.initialize?.({
    pluginId: BROWSER_PLATFORM_PLUGIN_ID,
    configuration: Object.freeze({}),
    clock: systemClock,
    events: {
      on: () => () => undefined,
      emit: async () => undefined,
    },
    capabilities: {
      register: (key: CapabilityKey<BrowserPlatform>, platform: BrowserPlatform) => {
        registrations.push({ key, platform });
      },
    },
    services: {},
  } as unknown as PluginInitializeContext);

  return { plugin, registrations };
}

describe('browser platform identities', () => {
  it('exports stable plugin and capability identities', () => {
    expect(BROWSER_PLATFORM_PLUGIN_ID).toBe('loom/browser-platform');
    expect(BROWSER_PLATFORM_CAPABILITY_ID).toBe('loom/browser-platform');
    expect(BROWSER_PLATFORM_KEY).toEqual({
      kind: 'platform',
      id: BROWSER_PLATFORM_CAPABILITY_ID,
    });
  });
});

describe('browser platform plugin', () => {
  it.each(['window', 'dedicated-worker'] as const)(
    'registers one explicitly supplied %s capability during initialize',
    async (scope) => {
      const indexedDB = fakeIdbFactory(scope);
      const plugin = createBrowserPlatformPlugin({ scope, indexedDB });
      const register = vi.fn();

      expect(register).not.toHaveBeenCalled();
      await plugin.initialize?.({
        capabilities: { register },
      } as unknown as PluginInitializeContext);

      expect(plugin.manifest).toMatchObject({
        id: BROWSER_PLATFORM_PLUGIN_ID,
        apiVersion: PLUGIN_API_VERSION,
      });
      expect(register).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledWith(
        BROWSER_PLATFORM_KEY,
        expect.objectContaining({ scope, indexedDB }),
      );
    },
  );

  it('keeps the descriptor immutable and preserves the supplied factory identity', async () => {
    const indexedDB = fakeIdbFactory('one');
    const { registrations } = await initialize({ scope: 'window', indexedDB });
    const registration = registrations[0];

    expect(registration?.key).toBe(BROWSER_PLATFORM_KEY);
    expect(registration?.platform.indexedDB).toBe(indexedDB);
    expect(Object.isFrozen(registration?.platform)).toBe(true);
  });

  it('creates isolated descriptors for separate plugin instances', async () => {
    const first = await initialize({
      scope: 'window',
      indexedDB: fakeIdbFactory('first'),
    });
    const second = await initialize({
      scope: 'dedicated-worker',
      indexedDB: fakeIdbFactory('second'),
    });

    expect(first.registrations[0]?.platform).not.toBe(second.registrations[0]?.platform);
    expect(first.registrations[0]?.platform.scope).toBe('window');
    expect(second.registrations[0]?.platform.scope).toBe('dedicated-worker');
  });

  it('rejects invalid explicit options without consulting browser globals', () => {
    expect(() =>
      createBrowserPlatformPlugin({
        scope: 'shared-worker' as 'window',
        indexedDB: fakeIdbFactory('invalid'),
      }),
    ).toThrow(TypeError);
    expect(() =>
      createBrowserPlatformPlugin({
        scope: 'window',
        indexedDB: null as unknown as IDBFactory,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createBrowserPlatformPlugin(null as unknown as CreateBrowserPlatformPluginOptions),
    ).toThrow(TypeError);
    expect(() => createBrowserPlatformPlugin({} as CreateBrowserPlatformPluginOptions)).toThrow(
      TypeError,
    );
    expect(() =>
      createBrowserPlatformPlugin({
        scope: 'window',
        indexedDB: 42 as unknown as IDBFactory,
      }),
    ).toThrow(TypeError);
  });
});
