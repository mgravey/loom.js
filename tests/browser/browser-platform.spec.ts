import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

const expectedOperations = ['workspace/list-files', 'workspace/read-file', 'workspace/write-file'];

test('composes IndexedDB and File System Access plugins in a Chromium window', async ({ page }) => {
  await openBuiltEsmHarness(page);

  const result = await page.evaluate(async (origin) => {
    const core = await import(`${origin}/packages/core/dist/index.js`);
    const types = await import(`${origin}/packages/types/dist/index.js`);
    const agentPackage = await import(`${origin}/packages/agent-codex/dist/index.js`);
    const browserPlatform = await import(`${origin}/packages/platform-browser/dist/index.js`);
    const indexedDbStorage = await import(`${origin}/packages/storage-indexeddb/dist/index.js`);
    const fileSystemWorkspace = await import(`${origin}/packages/workspace-fsa/dist/index.js`);
    const examples = await import(`${origin}/packages/examples/dist/index.js`);
    const suffix = `${String(Date.now())}-${String(Math.random()).slice(2)}`;
    const databaseName = `loom-phase-three-window-${suffix}`;
    const directoryName = `loom-phase-three-window-${suffix}`;
    const storageRoot = await navigator.storage.getDirectory();
    const directory = await storageRoot.getDirectoryHandle(directoryName, { create: true });
    const source = await directory.getFileHandle('source.txt', { create: true });
    const writable = await source.createWritable();
    await writable.write('hello Loom');
    await writable.close();

    const runtime = core.createLoomRuntime({
      plugins: [
        browserPlatform.createBrowserPlatformPlugin({ scope: 'window', indexedDB }),
        indexedDbStorage.createIndexedDbStoragePlugin({ indexedDB, databaseName }),
        fileSystemWorkspace.createFileSystemAccessWorkspacePlugin(directory),
        examples.createScriptedCodexModelPlugin(),
        agentPackage.createCodexAgentPlugin(),
      ],
      configuration: { [agentPackage.CODEX_AGENT_PLUGIN_ID]: { maxTurns: 4 } },
    });

    try {
      await runtime.initialize();
      await runtime.start();
      const platform = runtime.capabilities.get(browserPlatform.BROWSER_PLATFORM_KEY);
      const storage = runtime.capabilities.get(indexedDbStorage.INDEXEDDB_STORAGE_KEY);
      const namespace = types.namespacedId('loom-test/phase-three-window');
      const input = new Uint8Array([1, 2, 3]);
      await storage.set(namespace, 'window', input);
      input[0] = 9;
      const stored = [...((await storage.get(namespace, 'window')) ?? [])];
      const keys = await storage.list(namespace);
      const deleted = await storage.delete(namespace, 'window');

      const session = await runtime.sessions.create({
        id: types.sessionId('phase-three-window'),
      });
      const agent = await runtime.capabilities.get(agentPackage.CODEX_AGENT_KEY).create({
        model: runtime.capabilities.get(examples.EXAMPLE_CODEX_MODEL_KEY),
        tools: [
          runtime.capabilities.get(fileSystemWorkspace.FSA_LIST_FILES_TOOL_KEY),
          runtime.capabilities.get(fileSystemWorkspace.FSA_READ_FILE_TOOL_KEY),
          runtime.capabilities.get(fileSystemWorkspace.FSA_WRITE_FILE_TOOL_KEY),
        ],
        configuration: session.configuration[agentPackage.CODEX_AGENT_PLUGIN_ID],
      });
      const events = [];
      for await (const event of agent.run(
        { prompt: 'Process source.txt.' },
        { signal: session.signal, sessionId: session.metadata.id },
      )) {
        events.push(event);
      }
      const resultFile = await directory.getFileHandle('result.txt');
      const resultText = await (await resultFile.getFile()).text();
      await session.close();
      await runtime.stop();
      await runtime.dispose();

      let closedCode: string | undefined;
      try {
        await storage.get(namespace, 'window');
      } catch (error) {
        closedCode = (error as { readonly code?: string }).code;
      }

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB deletion was blocked.'));
      });
      await storageRoot.removeEntry(directoryName, { recursive: true });

      return {
        state: runtime.state,
        scope: platform.scope,
        stored,
        keys,
        deleted,
        resultText,
        operations: events
          .filter((event) => event.type === 'tool-start')
          .map((event) => event.operation),
        sessionCancelled: session.signal.cancelled,
        closedCode,
      };
    } catch (error) {
      try {
        await runtime.dispose();
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }, browserOrigin);

  expect(result).toEqual({
    state: 'disposed',
    scope: 'window',
    stored: [1, 2, 3],
    keys: ['window'],
    deleted: true,
    resultText: 'Processed: hello Loom',
    operations: expectedOperations,
    sessionCancelled: true,
    closedCode: 'STORAGE_CLOSED',
  });
});

test('composes IndexedDB and OPFS through built ESM in a dedicated Worker', async ({ page }) => {
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
  }, `${browserOrigin}/phase-three-worker.js`);

  expect(result).toEqual({
    ok: true,
    state: 'disposed',
    scope: 'dedicated-worker',
    stored: [1, 2, 3],
    keys: ['worker'],
    deleted: true,
    resultText: 'Processed: hello Loom',
    operations: expectedOperations,
    sessionCancelled: true,
    closedCode: 'STORAGE_CLOSED',
  });
});
