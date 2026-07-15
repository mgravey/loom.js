import { createServiceToken } from '@loom/plugin-api';
import { describe, expect, it } from 'vitest';

import { createServiceContainer } from '../src/service-container.js';

describe('service container', () => {
  it('applies runtime, session, and transient lifetimes', async () => {
    const container = createServiceContainer();
    const runtime = createServiceToken<object>('test/runtime');
    const session = createServiceToken<object>('test/session');
    const transient = createServiceToken<object>('test/transient');
    let runtimeCreates = 0;
    const registrar = container.registrarFor('test/plugin');
    registrar.registerFactory(runtime, () => ({ creation: ++runtimeCreates }));
    registrar.registerFactory(session, () => ({}), { lifetime: 'session' });
    registrar.registerFactory(transient, () => ({}), { lifetime: 'transient' });
    const first = container.createSessionScope();
    const second = container.createSessionScope();

    expect(await first.get(runtime)).toBe(await second.get(runtime));
    expect(runtimeCreates).toBe(1);
    expect(await first.get(session)).toBe(await first.get(session));
    expect(await first.get(session)).not.toBe(await second.get(session));
    expect(await first.get(transient)).not.toBe(await first.get(transient));
    await expect(container.root.get(session)).rejects.toThrow(/runtime scope/);
  });

  it('detects missing, duplicate, and circular services', async () => {
    const container = createServiceContainer();
    const one = createServiceToken<unknown>('test/one');
    const two = createServiceToken<unknown>('test/two');
    const missing = createServiceToken<unknown>('test/missing');
    const registrar = container.registrarFor('test/plugin');
    registrar.registerFactory(one, (services) => services.get(two));
    registrar.registerFactory(two, (services) => services.get(one));

    await expect(container.root.get(missing)).rejects.toThrow(/not registered/);
    await expect(container.root.tryGet(missing)).resolves.toBeUndefined();
    await expect(container.root.get(one)).rejects.toThrow(/test\/one -> test\/two -> test\/one/);
    expect(() => registrar.registerValue(one, 1)).toThrow(/already registered/);
  });

  it('shares concurrent runtime creation and retries failed factories', async () => {
    const container = createServiceContainer();
    const singleton = createServiceToken<object>('test/singleton');
    const retry = createServiceToken<number>('test/retry');
    let singletonCreates = 0;
    let attempts = 0;
    const registrar = container.registrarFor('test/plugin');
    registrar.registerFactory(singleton, async () => {
      singletonCreates += 1;
      await Promise.resolve();
      return {};
    });
    registrar.registerFactory(retry, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('retry me');
      return 2;
    });

    const [first, second] = await Promise.all([
      container.root.get(singleton),
      container.root.tryGet(singleton),
    ]);
    expect(first).toBe(second);
    expect(singletonCreates).toBe(1);
    await expect(container.root.get(retry)).rejects.toThrow('retry me');
    await expect(container.root.get(retry)).resolves.toBe(2);
    await container.removeOwner('test/missing');
  });

  it('freezes writes while preserving resolution and owner cleanup', async () => {
    const container = createServiceContainer();
    const token = createServiceToken<{ dispose(): void }>('test/owned');
    let disposed = false;
    container.registrarFor('test/plugin').registerFactory(token, () => ({
      dispose: () => {
        disposed = true;
      },
    }));
    await container.root.get(token);
    container.freeze();

    expect(container.frozen).toBe(true);
    expect(() =>
      container.registrarFor('test/plugin').registerValue(createServiceToken('test/late'), 1),
    ).toThrow(/closed/);
    await container.removeOwner('test/plugin');
    expect(disposed).toBe(true);
    await expect(container.root.get(token)).rejects.toThrow(/not registered/);
  });

  it('disposes created services in reverse order and is idempotent', async () => {
    const container = createServiceContainer();
    const calls: string[] = [];
    const one = createServiceToken<{ dispose(): void }>('test/one');
    const two = createServiceToken<{ dispose(): Promise<void> }>('test/two');
    const registrar = container.registrarFor('test/plugin');
    registrar.registerFactory(one, () => ({ dispose: () => calls.push('one') }), {
      lifetime: 'transient',
    });
    registrar.registerFactory(two, () => ({ dispose: async () => void calls.push('two') }), {
      lifetime: 'transient',
    });
    const scope = container.createSessionScope();
    await scope.get(one);
    await scope.get(two);

    await scope.dispose();
    await scope.dispose();
    expect(calls).toEqual(['two', 'one']);
    await expect(scope.get(one)).rejects.toThrow(/disposed/);
  });

  it('waits for pending async factories and disposes values that finish after scope close', async () => {
    const container = createServiceContainer();
    const token = createServiceToken<{ dispose(): void }>('test/pending');
    let release: (() => void) | undefined;
    let disposed = false;
    container.registrarFor('test/plugin').registerFactory(
      token,
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          dispose() {
            disposed = true;
          },
        };
      },
      { lifetime: 'session' },
    );
    const scope = container.createSessionScope();
    const resolution = scope.get(token);
    await Promise.resolve();

    const closing = scope.dispose();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release?.();
    await expect(resolution).rejects.toThrow(/finished creating after its scope was disposed/);
    await closing;
    expect(disposed).toBe(true);
  });

  it('owns registered values and prevents runtime services from capturing session services', async () => {
    const container = createServiceContainer();
    const calls: string[] = [];
    const value = createServiceToken<{ dispose(): void }>('test/value');
    const session = createServiceToken<object>('test/session-only');
    const runtime = createServiceToken<object>('test/runtime-with-dependency');
    const registrar = container.registrarFor('test/plugin');
    registrar.registerValue(value, { dispose: () => void calls.push('value') });
    registrar.registerFactory(session, () => ({}), { lifetime: 'session' });
    registrar.registerFactory(runtime, async (services) => services.get(session));

    const scope = container.createSessionScope();
    await expect(scope.get(runtime)).rejects.toThrow(/runtime scope/);
    await container.dispose();
    expect(calls).toEqual(['value']);
  });

  it('attempts every disposal and aggregates failures', async () => {
    const container = createServiceContainer();
    const calls: string[] = [];
    const one = createServiceToken<{ dispose(): void }>('test/one');
    const two = createServiceToken<{ dispose(): void }>('test/two');
    const registrar = container.registrarFor('test/plugin');
    registrar.registerFactory(one, () => ({
      dispose: () => {
        calls.push('one');
        throw new Error('one failed');
      },
    }));
    registrar.registerFactory(two, () => ({
      dispose: () => {
        calls.push('two');
        throw new Error('two failed');
      },
    }));
    await container.root.get(one);
    await container.root.get(two);

    await expect(container.dispose()).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
    });
    expect(calls).toEqual(['two', 'one']);
    await expect(container.dispose()).resolves.toBeUndefined();
    expect(() => container.createSessionScope()).toThrow(/disposed/);
  });
});
