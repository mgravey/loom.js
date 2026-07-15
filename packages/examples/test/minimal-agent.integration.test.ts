import {
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  createCodexAgentPlugin,
  type CodexAgentEvent,
} from '@loom/agent-codex';
import { createLoomRuntime } from '@loom/core';
import {
  createInMemoryTextWorkspace,
  createScriptedCodexModelPlugin,
  EXAMPLE_CODEX_MODEL_KEY,
  EXAMPLE_CODEX_SESSION_CONFIGURATION,
} from '@loom/examples';
import {
  LIST_FILES_TOOL_KEY,
  READ_FILE_TOOL_KEY,
  WRITE_FILE_TOOL_KEY,
  WORKSPACE_OPERATIONS,
  createWorkspaceToolsPlugin,
} from '@loom/tool-workspace';
import { sessionId } from '@loom/types';
import { describe, expect, it } from 'vitest';

describe('minimal agent public integration', () => {
  it('runs list, read, write, and final through a session overlay', async () => {
    const workspace = createInMemoryTextWorkspace();
    const runtime = createLoomRuntime({
      plugins: [
        createScriptedCodexModelPlugin(),
        createWorkspaceToolsPlugin({ workspace }),
        createCodexAgentPlugin(),
      ],
      configuration: {
        [CODEX_AGENT_PLUGIN_ID]: { maxTurns: 1 },
      },
    });

    await runtime.initialize();
    await runtime.start();
    const id = sessionId('phase-two-integration');
    const session = await runtime.sessions.create({
      id,
      configuration: {
        [CODEX_AGENT_PLUGIN_ID]: EXAMPLE_CODEX_SESSION_CONFIGURATION,
      },
    });
    const configuration = session.configuration[CODEX_AGENT_PLUGIN_ID];
    if (configuration === undefined) throw new Error('Expected the session agent overlay.');

    const factory = runtime.capabilities.get(CODEX_AGENT_KEY);
    const agent = await factory.create({
      model: runtime.capabilities.get(EXAMPLE_CODEX_MODEL_KEY),
      tools: [
        runtime.capabilities.get(LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(READ_FILE_TOOL_KEY),
        runtime.capabilities.get(WRITE_FILE_TOOL_KEY),
      ],
      configuration,
    });
    const events: CodexAgentEvent[] = [];
    for await (const event of agent.run(
      { prompt: 'Read source.txt and write the processed result.' },
      { signal: session.signal, sessionId: session.metadata.id },
    )) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === 'tool-start').map((event) => event.operation),
    ).toEqual([
      WORKSPACE_OPERATIONS.listFiles,
      WORKSPACE_OPERATIONS.readFile,
      WORKSPACE_OPERATIONS.writeFile,
    ]);
    expect(events.at(-2)).toEqual({ type: 'text', text: 'Workspace updated.' });
    expect(events.at(-1)).toEqual({ type: 'completed', turns: 4 });
    expect(workspace.snapshot()).toEqual({
      'result.txt': 'Processed: hello Loom',
      'source.txt': 'hello Loom',
    });
    expect(workspace.invocations()).toEqual([
      { operation: 'listFiles', sessionId: id },
      { operation: 'readFile', path: 'source.txt', sessionId: id },
      { operation: 'writeFile', path: 'result.txt', sessionId: id },
    ]);

    await session.close('integration complete');
    expect(session.signal.cancelled).toBe(true);
    expect(runtime.sessions.list()).toEqual([]);
    await runtime.stop();
    await runtime.dispose();
    expect(runtime.state).toBe('disposed');
  });
});
