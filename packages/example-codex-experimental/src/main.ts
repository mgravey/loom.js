import {
  CODEX_AGENT_KEY,
  CODEX_AGENT_PLUGIN_ID,
  createCodexAgentPlugin,
  type CodexAgentEvent,
} from '@loom/agent-codex';
import {
  createExtensionAuthPlugin,
  createExtensionAuthProvider,
  createExternalCredentialBroker,
  type ExternalMessageRuntime,
} from '@loom/auth-extension';
import { createLoomRuntime } from '@loom/core';
import {
  CODEX_EXPERIMENTAL_MODEL_KEY,
  createCodexExperimentalModelPlugin,
  type CodexResponsesHttpResponse,
  type CodexResponsesRequest,
  type CodexResponsesTransport,
} from '@loom/model-codex-experimental';
import { createBrowserPlatformPlugin } from '@loom/platform-browser';
import { sessionId } from '@loom/types';
import {
  FSA_LIST_FILES_TOOL_KEY,
  FSA_READ_FILE_TOOL_KEY,
  FSA_WRITE_FILE_TOOL_KEY,
  createFileSystemAccessWorkspacePlugin,
} from '@loom/workspace-fsa';

const PROVIDER_ID = 'openai/codex-experimental';
const MODEL_PORT_NAME = 'loom/codex-model-experimental/v1';
const MODEL_PROTOCOL = 'loom/codex-model-experimental';
const MODEL_PROTOCOL_VERSION = 1;
const RUN_SESSION_ID = sessionId('codex-experimental-browser-run');

interface DirectoryPickerHost {
  showDirectoryPicker(options?: {
    readonly mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

interface PortEvent<T> {
  addListener(listener: (value: T) => void): void;
}

interface ExternalPort {
  readonly onMessage: PortEvent<unknown>;
  readonly onDisconnect: PortEvent<void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface CodexExternalRuntime extends ExternalMessageRuntime {
  connect(extensionId: string, options: { readonly name: string }): ExternalPort;
}

function requiredElement<ElementType extends HTMLElement>(
  selector: string,
  constructor: new () => ElementType,
): ElementType {
  const element = globalThis.document.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing required element ${selector}.`);
  return element;
}

const extensionIdInput = requiredElement('#extension-id', HTMLInputElement);
const modelInput = requiredElement('#model', HTMLInputElement);
const promptInput = requiredElement('#prompt', HTMLTextAreaElement);
const checkAuthButton = requiredElement('#check-auth', HTMLButtonElement);
const runButton = requiredElement('#run', HTMLButtonElement);
const logoutButton = requiredElement('#logout', HTMLButtonElement);
const statusElement = requiredElement('#status', HTMLParagraphElement);
const logElement = requiredElement('#log', HTMLPreElement);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function pageDiagnostic(
  event: string,
  details: Readonly<Record<string, string | number | boolean>> = {},
): void {
  globalThis.console.info('[loom:page-extension]', Object.freeze({ event, ...details }));
}

function diagnosticCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Z_]{1,64}$/u.test(value) ? value : fallback;
}

function providerDiagnostic(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:[\]-]{1,256}$/u.test(value)
    ? value
    : 'unclassified';
}

function diagnosticStage(value: unknown): string {
  return typeof value === 'string' && /^[a-z-]{1,32}$/u.test(value) ? value : 'unknown';
}

function extensionRuntime(): CodexExternalRuntime {
  const runtime = (
    globalThis as typeof globalThis & {
      readonly chrome?: { readonly runtime?: CodexExternalRuntime };
    }
  ).chrome?.runtime;
  if (
    runtime === undefined ||
    typeof runtime.sendMessage !== 'function' ||
    typeof runtime.connect !== 'function'
  ) {
    throw new Error('Chrome external extension messaging is unavailable.');
  }
  return runtime;
}

function selectedExtensionId(): string {
  const value = extensionIdInput.value.trim();
  if (value === '') throw new Error('Enter the experimental extension ID.');
  return value;
}

function directoryPicker(): DirectoryPickerHost['showDirectoryPicker'] {
  const picker = (globalThis as typeof globalThis & Partial<DirectoryPickerHost>)
    .showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new Error('This browser does not support directory selection.');
  }
  return picker.bind(globalThis);
}

function createChunkStream(): {
  readonly body: AsyncIterable<string>;
  push(chunk: string): void;
  finish(): void;
  fail(error: Error): void;
} {
  const chunks: string[] = [];
  const waiters: (() => void)[] = [];
  let finished = false;
  let failure: Error | undefined;
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = chunks.shift();
          if (chunk !== undefined) {
            yield chunk;
            continue;
          }
          if (failure !== undefined) throw failure;
          if (finished) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    },
    push(chunk) {
      if (finished || failure !== undefined) return;
      chunks.push(chunk);
      wake();
    },
    finish() {
      finished = true;
      wake();
    },
    fail(error) {
      failure = error;
      wake();
    },
  };
}

function createExtensionModelTransport(
  runtime: CodexExternalRuntime,
  extensionId: string,
): CodexResponsesTransport {
  let nextRequest = 0;
  return Object.freeze({
    send(request: CodexResponsesRequest): Promise<CodexResponsesHttpResponse> {
      nextRequest += 1;
      const requestId = `loom-model-${String(nextRequest)}`;
      pageDiagnostic('model.port.connect', { requestId });
      const port = runtime.connect(extensionId, { name: MODEL_PORT_NAME });
      const stream = createChunkStream();
      let started = false;
      let ended = false;
      let settled = false;
      let unsubscribe = (): void => undefined;
      return new Promise((resolve, reject) => {
        const rejectOnce = (error: Error): void => {
          if (settled) {
            stream.fail(error);
          } else {
            settled = true;
            reject(error);
          }
        };
        port.onMessage.addListener((message) => {
          if (!isRecord(message) || message.requestId !== requestId) return;
          if (message.type === 'start' && typeof message.status === 'number' && !started) {
            pageDiagnostic('model.response.start', { requestId, status: message.status });
            if (message.status < 200 || message.status >= 300) {
              appendLog(`Extension provider HTTP status: ${String(message.status)}.`);
            }
            started = true;
            settled = true;
            resolve(Object.freeze({ status: message.status, body: stream.body }));
            return;
          }
          if (message.type === 'chunk' && typeof message.chunk === 'string' && started) {
            pageDiagnostic('model.response.chunk', {
              requestId,
              characters: message.chunk.length,
            });
            stream.push(message.chunk);
            return;
          }
          if (message.type === 'end') {
            pageDiagnostic('model.response.end', { requestId });
            ended = true;
            unsubscribe();
            stream.finish();
            return;
          }
          if (message.type === 'provider-error' && typeof message.status === 'number') {
            const providerCode = providerDiagnostic(message.providerCode);
            const providerType = providerDiagnostic(message.providerType);
            const providerParam = providerDiagnostic(message.providerParam);
            pageDiagnostic('model.response.rejected', {
              requestId,
              status: message.status,
              providerCode,
              providerType,
              providerParam,
            });
            appendLog(
              `Provider rejected the request (${String(message.status)}): ${providerCode}; type ${providerType}; parameter ${providerParam}.`,
            );
            return;
          }
          if (message.type === 'error') {
            const code = diagnosticCode(message.code, 'UNKNOWN_EXTENSION_ERROR');
            const stage = diagnosticStage(message.stage);
            pageDiagnostic('model.response.error', { requestId, code, stage });
            appendLog(`Extension transport error: ${code} at ${stage}.`);
            unsubscribe();
            rejectOnce(new Error('Experimental extension model request failed.'));
          }
        });
        port.onDisconnect.addListener(() => {
          pageDiagnostic('model.port.disconnect', { requestId, ended });
          unsubscribe();
          if (!ended) rejectOnce(new Error('Experimental extension model port disconnected.'));
        });
        if (request.signal !== undefined) {
          unsubscribe = request.signal.onCancel(() => {
            stream.fail(new Error('Experimental extension model request was cancelled.'));
            port.disconnect();
          });
        }
        pageDiagnostic('model.request.send', {
          requestId,
          characters: request.body.length,
          cancellable: request.signal !== undefined,
        });
        port.postMessage({
          protocol: MODEL_PROTOCOL,
          version: MODEL_PROTOCOL_VERSION,
          type: 'generate',
          requestId,
          sessionId: RUN_SESSION_ID,
          threadId: RUN_SESSION_ID,
          body: request.body,
        });
      });
    },
  });
}

function authProvider() {
  const broker = createExternalCredentialBroker({
    extensionId: selectedExtensionId(),
    runtime: extensionRuntime(),
  });
  return createExtensionAuthProvider({ broker, providerId: PROVIDER_ID });
}

async function refreshAuthenticationStatus(updateStatus = true): Promise<boolean> {
  pageDiagnostic('auth.status.request');
  const authenticated = await authProvider().isAuthenticated();
  pageDiagnostic('auth.status.response', { authenticated });
  runButton.disabled = !authenticated;
  logoutButton.disabled = !authenticated;
  if (updateStatus) {
    setStatus(
      authenticated
        ? 'Authenticated. Choose a directory to run the experimental Codex model.'
        : 'Not authenticated. Complete sign-in from the extension options page.',
    );
  }
  return authenticated;
}

function describeEvent(event: CodexAgentEvent): string {
  if (event.type === 'text') return event.text;
  if (event.type === 'tool-start') return `\nTool started: ${event.operation}`;
  if (event.type === 'tool-finish') return `Tool finished: ${event.operation}`;
  return `\nAgent completed after ${String(event.turns)} turns.`;
}

async function runAgent(): Promise<void> {
  runButton.disabled = true;
  checkAuthButton.disabled = true;
  logoutButton.disabled = true;
  logElement.textContent = '';
  let runtime: ReturnType<typeof createLoomRuntime> | undefined;
  try {
    const directory = await directoryPicker()({ mode: 'readwrite' });
    const extensionId = selectedExtensionId();
    const externalRuntime = extensionRuntime();
    const broker = createExternalCredentialBroker({ extensionId, runtime: externalRuntime });
    const model = modelInput.value.trim();
    const prompt = promptInput.value.trim();
    if (model === '' || prompt === '') throw new Error('Model and request are required.');

    runtime = createLoomRuntime({
      plugins: [
        createBrowserPlatformPlugin({ scope: 'window', indexedDB: globalThis.indexedDB }),
        createFileSystemAccessWorkspacePlugin(directory),
        createExtensionAuthPlugin({ broker, providerId: PROVIDER_ID }),
        createCodexExperimentalModelPlugin({
          model,
          transport: createExtensionModelTransport(externalRuntime, extensionId),
        }),
        createCodexAgentPlugin(),
      ],
      configuration: { [CODEX_AGENT_PLUGIN_ID]: { maxTurns: 8 } },
      errorSink: (error) => appendLog(`Runtime event error: ${errorMessage(error)}`),
    });
    await runtime.initialize();
    await runtime.start();
    const session = await runtime.sessions.create({ id: RUN_SESSION_ID });
    const configuration = session.configuration[CODEX_AGENT_PLUGIN_ID];
    if (configuration === undefined) throw new Error('Agent configuration is unavailable.');
    const agent = await runtime.capabilities.get(CODEX_AGENT_KEY).create({
      model: runtime.capabilities.get(CODEX_EXPERIMENTAL_MODEL_KEY),
      tools: [
        runtime.capabilities.get(FSA_LIST_FILES_TOOL_KEY),
        runtime.capabilities.get(FSA_READ_FILE_TOOL_KEY),
        runtime.capabilities.get(FSA_WRITE_FILE_TOOL_KEY),
      ],
      configuration,
    });
    setStatus('Running the experimental Codex model through the extension…');
    for await (const event of agent.run(
      { prompt },
      { sessionId: session.metadata.id, signal: session.signal },
    )) {
      appendLog(describeEvent(event));
    }
    await session.close('Experimental run completed');
    setStatus('Run complete.');
  } catch (error) {
    appendLog(`Error: ${errorMessage(error)}`);
    setStatus('Run failed. See the sanitized event log.');
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.dispose();
      } catch (error) {
        appendLog(`Cleanup error: ${errorMessage(error)}`);
      }
    }
    checkAuthButton.disabled = false;
    try {
      await refreshAuthenticationStatus(false);
    } catch {
      runButton.disabled = true;
      logoutButton.disabled = true;
    }
  }
}

checkAuthButton.addEventListener('click', () => {
  void refreshAuthenticationStatus().catch((error: unknown) => {
    runButton.disabled = true;
    logoutButton.disabled = true;
    setStatus(`Connection failed: ${errorMessage(error)}`);
  });
});

logoutButton.addEventListener('click', () => {
  logoutButton.disabled = true;
  pageDiagnostic('auth.logout.request');
  void authProvider()
    .logout()
    .then(() => {
      pageDiagnostic('auth.logout.response', { succeeded: true });
      return refreshAuthenticationStatus();
    })
    .catch((error: unknown) => setStatus(`Logout failed: ${errorMessage(error)}`));
});

runButton.addEventListener('click', () => {
  void runAgent();
});
