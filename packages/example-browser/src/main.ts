import {
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  createCodexAgentPlugin,
  type CodexAgentEvent,
} from '@mgravey/loom-agent-codex';
import { createLoomRuntime } from '@mgravey/loom-core';
import {
  EXAMPLE_CODEX_MODEL_KEY,
  EXAMPLE_CODEX_SESSION_CONFIGURATION,
  createScriptedCodexModelPlugin,
} from '@mgravey/loom-examples';
import { createBrowserPlatformPlugin } from '@mgravey/loom-platform-browser';
import { createIndexedDbStoragePlugin } from '@mgravey/loom-storage-indexeddb';
import { sessionId } from '@mgravey/loom-types';
import {
  FSA_LIST_FILES_TOOL_KEY,
  FSA_READ_FILE_TOOL_KEY,
  FSA_WRITE_FILE_TOOL_KEY,
  createFileSystemAccessWorkspacePlugin,
} from '@mgravey/loom-workspace-fsa';

const DATABASE_NAME = 'loom-example-browser';
const EXAMPLE_SESSION_ID = sessionId('browser-example-run');

interface DirectoryPickerOptions {
  readonly mode?: 'read' | 'readwrite';
}

interface DirectoryPickerHost {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}

function requiredElement<ElementType extends HTMLElement>(
  selector: string,
  constructor: new () => ElementType,
): ElementType {
  const element = globalThis.document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Browser example is missing required element "${selector}".`);
  }
  return element;
}

const runButton = requiredElement('#run', HTMLButtonElement);
const statusElement = requiredElement('#status', HTMLParagraphElement);
const logElement = requiredElement('#log', HTMLPreElement);

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function appendLog(message: string): void {
  logElement.textContent = `${logElement.textContent}${message}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directoryPicker(): DirectoryPickerHost['showDirectoryPicker'] {
  const host = globalThis as typeof globalThis & Partial<DirectoryPickerHost>;
  if (typeof host.showDirectoryPicker !== 'function') {
    throw new Error(
      'This browser does not expose showDirectoryPicker(). Use a compatible browser in a secure context.',
    );
  }
  return host.showDirectoryPicker.bind(host);
}

function describeEvent(event: CodexAgentEvent): string {
  if (event.type === 'text') return `Agent: ${event.text}`;
  if (event.type === 'tool-start') {
    return `Tool started: ${event.operation} (${event.callId})`;
  }
  if (event.type === 'tool-finish') {
    return `Tool finished: ${event.operation} (${event.callId})`;
  }
  if (event.type === 'context-compacted') {
    return `Agent context compacted (${String(event.inputCharacters)} → ${String(event.outputCharacters)} characters).`;
  }
  return `Agent completed after ${String(event.turns)} turns.`;
}

async function runExample(): Promise<void> {
  runButton.disabled = true;
  logElement.textContent = '';
  setStatus('Waiting for a directory…');

  let runtime: ReturnType<typeof createLoomRuntime> | undefined;
  let closeSession: (() => Promise<void>) | undefined;
  let completed = false;

  try {
    // This call occurs before the first suspension, preserving the button's user activation.
    const directory = await directoryPicker()({ mode: 'readwrite' });
    const indexedDB = globalThis.indexedDB;

    setStatus('Starting an isolated Loom runtime…');
    runtime = createLoomRuntime({
      plugins: [
        createBrowserPlatformPlugin({ scope: 'window', indexedDB }),
        createIndexedDbStoragePlugin({ indexedDB, databaseName: DATABASE_NAME }),
        createFileSystemAccessWorkspacePlugin(directory),
        createScriptedCodexModelPlugin(),
        createCodexAgentPlugin(),
      ],
      configuration: {
        [CODEX_AGENT_PLUGIN_ID]: EXAMPLE_CODEX_SESSION_CONFIGURATION,
      },
      errorSink: (error) => appendLog(`Runtime event error: ${errorMessage(error)}`),
    });

    await runtime.initialize();
    await runtime.start();
    const session = await runtime.sessions.create({
      id: EXAMPLE_SESSION_ID,
      configuration: {
        [CODEX_AGENT_PLUGIN_ID]: EXAMPLE_CODEX_SESSION_CONFIGURATION,
      },
      attributes: { example: 'browser-fsa' },
    });
    closeSession = () => session.close('Browser example completed');

    const configuration = session.configuration[CODEX_AGENT_PLUGIN_ID];
    if (configuration === undefined) {
      throw new Error('The Codex agent session configuration is unavailable.');
    }

    const factory = runtime.capabilities.get(CODEX_AGENT_KEY);
    const agent = await factory.create({
      model: runtime.capabilities.get(EXAMPLE_CODEX_MODEL_KEY),
      tools: [
        runtime.capabilities.get(FSA_LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(FSA_READ_FILE_TOOL_KEY),
        runtime.capabilities.get(FSA_WRITE_FILE_TOOL_KEY),
      ],
      configuration,
    });

    setStatus('Running the scripted agent…');
    for await (const event of agent.run(
      { prompt: 'Read source.txt and write the processed result to result.txt.' },
      { sessionId: session.metadata.id, signal: session.signal },
    )) {
      appendLog(describeEvent(event));
    }

    completed = true;
    setStatus('Complete. The selected directory now contains result.txt.');
  } catch (error) {
    const message = errorMessage(error);
    appendLog(`Error: ${message}`);
    setStatus(`Run failed: ${message}`);
  } finally {
    if (closeSession !== undefined) {
      try {
        await closeSession();
      } catch (error) {
        appendLog(`Session cleanup error: ${errorMessage(error)}`);
        completed = false;
      }
    }
    if (runtime !== undefined) {
      try {
        await runtime.dispose();
      } catch (error) {
        appendLog(`Runtime cleanup error: ${errorMessage(error)}`);
        completed = false;
      }
    }
    if (!completed && !statusElement.textContent.startsWith('Run failed')) {
      setStatus('The run ended with a cleanup error. See the event log.');
    }
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', () => {
  void runExample();
});
