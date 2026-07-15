import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

test('composes and disposes Loom in a Chromium window', async ({ page }) => {
  await openBuiltEsmHarness(page);

  const result = await page.evaluate(async (origin) => {
    const core = await import(`${origin}/packages/core/dist/index.js`);
    const api = await import(`${origin}/packages/plugin-api/dist/index.js`);
    const types = await import(`${origin}/packages/types/dist/index.js`);
    const examples = await import(`${origin}/packages/examples/dist/index.js`);

    const runtime = core.createLoomRuntime({
      plugins: [examples.createAllCapabilitiesPlugin()],
    });
    await runtime.initialize();
    await runtime.start();

    const auth = runtime.capabilities.get(api.authKey(examples.EXAMPLE_CAPABILITY_IDS.auth));
    const tool = runtime.capabilities.get(api.toolKey(examples.EXAMPLE_CAPABILITY_IDS.tool));
    const storage = runtime.capabilities.get(
      api.storageKey(examples.EXAMPLE_CAPABILITY_IDS.storage),
    );
    const namespace = types.namespacedId('loom-example/browser-test');
    await storage.set(namespace, 'value', new Uint8Array([1, 2, 3]));
    const stored = await storage.get(namespace, 'value');

    const session = await runtime.sessions.create({ id: types.sessionId('browser-session') });
    const service = await runtime.services.get(examples.EXAMPLE_STATUS_SERVICE);
    await session.close();

    const running = {
      state: runtime.state,
      capabilityCount: runtime.capabilities.list().length,
      token: await auth.getAccessToken(),
      toolOutput: await tool.execute({ source: 'window' }),
      stored: [...(stored ?? [])],
      serviceReady: service.ready,
      sessionCancelled: session.signal.cancelled,
    };

    await runtime.stop();
    await runtime.dispose();
    return { running, finalState: runtime.state };
  }, browserOrigin);

  expect(result).toEqual({
    running: {
      state: 'running',
      capabilityCount: 9,
      token: 'example-access-token',
      toolOutput: { source: 'window' },
      stored: [1, 2, 3],
      serviceReady: true,
      sessionCancelled: true,
    },
    finalState: 'disposed',
  });
});

test('composes and disposes Loom in a dedicated Chromium Worker', async ({ page }) => {
  await openBuiltEsmHarness(page);

  const result = await page.evaluate(async (workerUrl) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(workerUrl, { type: 'module' });
      worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage(undefined);
    });
  }, `${browserOrigin}/worker.js`);

  expect(result).toEqual({
    ok: true,
    state: 'disposed',
    token: 'example-access-token',
    capabilityCount: 9,
  });
});
