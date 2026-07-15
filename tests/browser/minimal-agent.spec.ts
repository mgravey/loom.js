import { expect, test } from '@playwright/test';

import { browserOrigin, openBuiltEsmHarness } from './built-esm-harness.js';

const expectedOperations = ['workspace/list-files', 'workspace/read-file', 'workspace/write-file'];

test('runs the minimal agent through built ESM in a Chromium window', async ({ page }) => {
  await openBuiltEsmHarness(page);

  const result = await page.evaluate(async (origin) => {
    const core = await import(`${origin}/packages/core/dist/index.js`);
    const types = await import(`${origin}/packages/types/dist/index.js`);
    const agentPackage = await import(`${origin}/packages/agent-codex/dist/index.js`);
    const workspacePackage = await import(`${origin}/packages/tool-workspace/dist/index.js`);
    const examples = await import(`${origin}/packages/examples/dist/index.js`);
    const workspace = examples.createInMemoryTextWorkspace();
    const runtime = core.createLoomRuntime({
      plugins: [
        examples.createScriptedCodexModelPlugin(),
        workspacePackage.createWorkspaceToolsPlugin({ workspace }),
        agentPackage.createCodexAgentPlugin(),
      ],
      configuration: { [agentPackage.CODEX_AGENT_PLUGIN_ID]: { maxTurns: 1 } },
    });
    await runtime.initialize();
    await runtime.start();
    const session = await runtime.sessions.create({
      id: types.sessionId('phase-two-window'),
      configuration: {
        [agentPackage.CODEX_AGENT_PLUGIN_ID]: examples.EXAMPLE_CODEX_SESSION_CONFIGURATION,
      },
    });
    const agent = await runtime.capabilities.get(agentPackage.CODEX_AGENT_KEY).create({
      model: runtime.capabilities.get(examples.EXAMPLE_CODEX_MODEL_KEY),
      tools: [
        runtime.capabilities.get(workspacePackage.LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(workspacePackage.READ_FILE_TOOL_KEY),
        runtime.capabilities.get(workspacePackage.WRITE_FILE_TOOL_KEY),
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
    await session.close();
    const sessionCancelled = session.signal.cancelled;
    const sessionsAfterClose = runtime.sessions.list().length;
    await runtime.stop();
    await runtime.dispose();
    return {
      state: runtime.state,
      operations: events
        .filter((event) => event.type === 'tool-start')
        .map((event) => event.operation),
      files: workspace.snapshot(),
      trace: workspace.invocations(),
      sessionCancelled,
      sessionsAfterClose,
    };
  }, browserOrigin);

  expect(result).toEqual({
    state: 'disposed',
    operations: expectedOperations,
    files: { 'result.txt': 'Processed: hello Loom', 'source.txt': 'hello Loom' },
    trace: [
      { operation: 'listFiles', sessionId: 'phase-two-window' },
      { operation: 'readFile', path: 'source.txt', sessionId: 'phase-two-window' },
      { operation: 'writeFile', path: 'result.txt', sessionId: 'phase-two-window' },
    ],
    sessionCancelled: true,
    sessionsAfterClose: 0,
  });
});

test('runs the minimal agent through built ESM in a dedicated Worker', async ({ page }) => {
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
  }, `${browserOrigin}/phase-two-worker.js`);

  expect(result).toEqual({
    ok: true,
    state: 'disposed',
    operations: expectedOperations,
    files: { 'result.txt': 'Processed: hello Loom', 'source.txt': 'hello Loom' },
    trace: [
      { operation: 'listFiles', sessionId: 'phase-two-worker' },
      { operation: 'readFile', path: 'source.txt', sessionId: 'phase-two-worker' },
      { operation: 'writeFile', path: 'result.txt', sessionId: 'phase-two-worker' },
    ],
    sessionsAfterClose: 0,
  });
});
