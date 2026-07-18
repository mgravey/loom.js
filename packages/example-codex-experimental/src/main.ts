import type { CodexAgentEvent } from '@loom/agent-codex';
import {
  createExternalCredentialBroker,
  createExtensionAuthProvider,
  type ExternalMessageRuntime,
} from '@loom/auth-extension';
import { createCodingSession, type CodingSession } from '@loom/coding';
import {
  createPyodideExecutionRuntime,
  createQuickJsExecutionRuntime,
  createWebContainerExecutionRuntime,
  executeBrowserWorkspace,
  type BrowserExecutionProject,
  type BrowserExecutionRuntime,
  type BrowserExecutionWorkspace,
} from '@loom/execution-browser';
import {
  createCodexExperimentalModel,
  type CodexResponsesHttpResponse,
  type CodexResponsesRequest,
  type CodexResponsesTransport,
} from '@loom/model-codex-experimental';
import {
  createMemoryProjectWorkspace,
  createProjectWorkspaceTools,
  createWorkspaceTools,
  exportWorkspaceZip,
  importBrowserFolderFiles,
  importWorkspaceEntries,
  importWorkspaceZip,
  snapshotWorkspace,
  type ProjectWorkspace,
  type WorkspaceImportEntry,
  type WorkspacePath,
  type WorkspaceTool,
} from '@loom/tool-workspace';
import { createCancellationSource, sessionId, type CancellationSource } from '@loom/types';
import { createFileSystemAccessProjectWorkspace } from '@loom/workspace-fsa';

const PROVIDER_ID = 'openai/codex-experimental';
const MODEL_PORT_NAME = 'loom/codex-model-experimental/v1';
const MODEL_PROTOCOL = 'loom/codex-model-experimental';
const MODEL_PROTOCOL_VERSION = 1;
const RUN_SESSION_ID = sessionId('codex-experimental-browser-run');
const OPFS_DIRECTORY = 'loom-workbench';
const OPFS_ARCHIVE = 'project.zip';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const EXTENSION_ID_STORAGE_KEY = 'loom.chrome-extension-id';

interface LoomDeploymentConfig {
  readonly chromeExtensionId?: string;
}

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
const cancelRunButton = requiredElement('#cancel-run', HTMLButtonElement);
const logoutButton = requiredElement('#logout', HTMLButtonElement);
const statusElement = requiredElement('#status', HTMLParagraphElement);
const logElement = requiredElement('#log', HTMLPreElement);
const workspaceMode = requiredElement('#workspace-mode', HTMLSelectElement);
const openWorkspaceButton = requiredElement('#open-workspace', HTMLButtonElement);
const importFolderButton = requiredElement('#import-folder', HTMLButtonElement);
const importZipButton = requiredElement('#import-zip', HTMLButtonElement);
const exportZipButton = requiredElement('#export-zip', HTMLButtonElement);
const folderInput = requiredElement('#folder-input', HTMLInputElement);
const zipInput = requiredElement('#zip-input', HTMLInputElement);
const fileList = requiredElement('#file-list', HTMLUListElement);
const editor = requiredElement('#editor', HTMLTextAreaElement);
const editorTitle = requiredElement('#editor-title', HTMLHeadingElement);
const saveFileButton = requiredElement('#save-file', HTMLButtonElement);
const runtimeSelect = requiredElement('#runtime', HTMLSelectElement);
const commandInput = requiredElement('#command', HTMLInputElement);
const runCommandButton = requiredElement('#run-command', HTMLButtonElement);
const runtimeOutput = requiredElement('#runtime-output', HTMLPreElement);

function deploymentExtensionId(): string | undefined {
  const configured = (
    globalThis as typeof globalThis & {
      readonly LOOM_DEPLOYMENT_CONFIG?: LoomDeploymentConfig;
    }
  ).LOOM_DEPLOYMENT_CONFIG?.chromeExtensionId;
  return typeof configured === 'string' && EXTENSION_ID_PATTERN.test(configured)
    ? configured
    : undefined;
}

function storedExtensionId(): string | undefined {
  try {
    const stored = globalThis.localStorage.getItem(EXTENSION_ID_STORAGE_KEY);
    return stored !== null && EXTENSION_ID_PATTERN.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function queryExtensionId(): string | undefined {
  const value = new URL(globalThis.location.href).searchParams.get('extensionId');
  return value !== null && EXTENSION_ID_PATTERN.test(value) ? value : undefined;
}

extensionIdInput.value = queryExtensionId() ?? storedExtensionId() ?? deploymentExtensionId() ?? '';

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

function appendRuntimeOutput(chunk: string): void {
  runtimeOutput.textContent = `${runtimeOutput.textContent}${chunk}`;
  runtimeOutput.scrollTop = runtimeOutput.scrollHeight;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
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
  if (!EXTENSION_ID_PATTERN.test(value)) {
    throw new Error('Enter a valid 32-character Chrome extension ID.');
  }
  try {
    globalThis.localStorage.setItem(EXTENSION_ID_STORAGE_KEY, value);
  } catch {
    // The ID is non-secret deployment metadata; storage availability is optional.
  }
  return value;
}

function directoryPicker(): DirectoryPickerHost['showDirectoryPicker'] {
  const picker = (globalThis as typeof globalThis & Partial<DirectoryPickerHost>)
    .showDirectoryPicker;
  if (typeof picker !== 'function')
    throw new Error('This browser does not support directory selection.');
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
      if (!finished && failure === undefined) chunks.push(chunk);
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
      const port = runtime.connect(extensionId, { name: MODEL_PORT_NAME });
      const stream = createChunkStream();
      let started = false;
      let ended = false;
      let settled = false;
      let unsubscribe = (): void => undefined;
      return new Promise((resolve, reject) => {
        const rejectOnce = (error: Error): void => {
          if (settled) stream.fail(error);
          else {
            settled = true;
            reject(error);
          }
        };
        port.onMessage.addListener((message) => {
          if (!isRecord(message) || message.requestId !== requestId) return;
          if (message.type === 'start' && typeof message.status === 'number' && !started) {
            started = true;
            settled = true;
            resolve(Object.freeze({ status: message.status, body: stream.body }));
            return;
          }
          if (message.type === 'chunk' && typeof message.chunk === 'string' && started) {
            stream.push(message.chunk);
            return;
          }
          if (message.type === 'end') {
            ended = true;
            unsubscribe();
            stream.finish();
            return;
          }
          if (message.type === 'provider-error' && typeof message.status === 'number') {
            appendLog(
              `Provider rejected the request (${String(message.status)}): ${providerDiagnostic(message.providerCode)}; type ${providerDiagnostic(message.providerType)}; parameter ${providerDiagnostic(message.providerParam)}.`,
            );
            return;
          }
          if (message.type === 'error') {
            appendLog(
              `Extension transport error: ${diagnosticCode(message.code, 'UNKNOWN_EXTENSION_ERROR')} at ${diagnosticStage(message.stage)}.`,
            );
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
        port.postMessage({
          protocol: MODEL_PROTOCOL,
          version: MODEL_PROTOCOL_VERSION,
          type: 'generate',
          requestId,
          sessionId: RUN_SESSION_ID,
          threadId: RUN_SESSION_ID,
          body: request.body,
          wireProtocol: request.wireProtocol,
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

let authenticated = false;
let activeWorkspace: ProjectWorkspace | undefined;
let activeWorkspaceMode: 'direct' | 'memory' | 'opfs' | undefined;
let codingSession: CodingSession | undefined;
let selectedFile: WorkspacePath | undefined;
let runtimeCancellation: CancellationSource | undefined;

const executionRuntimes: Readonly<Record<string, BrowserExecutionRuntime>> = Object.freeze({
  quickjs: createQuickJsExecutionRuntime(),
  node: createWebContainerExecutionRuntime({ coep: 'credentialless' }),
  python: createPyodideExecutionRuntime({
    indexURL: 'https://cdn.jsdelivr.net/npm/pyodide@314.0.2/',
  }),
});

function updateControls(): void {
  const hasWorkspace = activeWorkspace !== undefined;
  runButton.disabled = !authenticated;
  logoutButton.disabled = !authenticated;
  exportZipButton.disabled = !hasWorkspace;
  runCommandButton.disabled = !hasWorkspace;
  editor.disabled = selectedFile === undefined;
  saveFileButton.disabled = selectedFile === undefined;
  runButton.textContent = hasWorkspace ? 'Run agent' : 'Choose directory and run';
}

async function refreshAuthenticationStatus(updateStatus = true): Promise<boolean> {
  pageDiagnostic('auth.status.request');
  authenticated = await authProvider().isAuthenticated();
  pageDiagnostic('auth.status.response', { authenticated });
  updateControls();
  if (updateStatus) {
    setStatus(
      authenticated
        ? 'Authenticated. Open a workspace or run the agent to choose one.'
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

async function disposeCodingSession(): Promise<void> {
  if (codingSession !== undefined) await codingSession.dispose();
  codingSession = undefined;
}

async function opfsArchiveFile(create: boolean): Promise<FileSystemFileHandle> {
  const root = await globalThis.navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create });
  return directory.getFileHandle(OPFS_ARCHIVE, { create });
}

async function loadOpfsWorkspace(): Promise<ProjectWorkspace> {
  const workspace = createMemoryProjectWorkspace();
  try {
    const archive = await opfsArchiveFile(false);
    await importWorkspaceZip(
      workspace,
      new Uint8Array(await (await archive.getFile()).arrayBuffer()),
    );
  } catch (error) {
    if (!isRecord(error) || error.name !== 'NotFoundError') throw error;
  }
  return workspace;
}

async function persistOpfsWorkspace(): Promise<void> {
  if (activeWorkspaceMode !== 'opfs' || activeWorkspace === undefined) return;
  const archive = await opfsArchiveFile(true);
  const writable = await archive.createWritable();
  try {
    await writable.write(ownedBuffer(await exportWorkspaceZip(activeWorkspace)));
    await writable.close();
  } catch (error) {
    await writable.abort(error);
    throw error;
  }
}

async function openWorkspace(): Promise<ProjectWorkspace> {
  await disposeCodingSession();
  selectedFile = undefined;
  const mode = workspaceMode.value;
  if (mode === 'direct') {
    const root = await directoryPicker()({ mode: 'readwrite' });
    activeWorkspace = createFileSystemAccessProjectWorkspace(root);
    activeWorkspaceMode = 'direct';
  } else if (mode === 'opfs') {
    activeWorkspace = await loadOpfsWorkspace();
    activeWorkspaceMode = 'opfs';
  } else {
    activeWorkspace = createMemoryProjectWorkspace();
    activeWorkspaceMode = 'memory';
  }
  await renderFiles();
  updateControls();
  setStatus(`Workspace opened in ${activeWorkspaceMode} mode.`);
  return activeWorkspace;
}

async function ensureWorkspace(): Promise<ProjectWorkspace> {
  return activeWorkspace ?? openWorkspace();
}

async function renderFiles(): Promise<void> {
  fileList.replaceChildren();
  if (activeWorkspace === undefined) {
    const item = globalThis.document.createElement('li');
    item.textContent = 'No workspace open.';
    fileList.append(item);
    return;
  }
  const entries = await snapshotWorkspace(activeWorkspace);
  const files = entries.filter((entry) => entry.kind === 'file');
  if (files.length === 0) {
    const item = globalThis.document.createElement('li');
    item.textContent = 'Workspace is empty.';
    fileList.append(item);
    return;
  }
  for (const entry of files) {
    const item = globalThis.document.createElement('li');
    const button = globalThis.document.createElement('button');
    button.type = 'button';
    button.textContent = entry.path;
    button.addEventListener('click', () => {
      void selectEditorFile(entry.path).catch((error: unknown) => setStatus(errorMessage(error)));
    });
    item.append(button);
    fileList.append(item);
  }
}

async function selectEditorFile(path: WorkspacePath): Promise<void> {
  if (activeWorkspace === undefined) return;
  try {
    editor.value = await activeWorkspace.readFile(path);
    selectedFile = path;
    editorTitle.textContent = path;
    updateControls();
  } catch {
    selectedFile = undefined;
    editor.value = '';
    editorTitle.textContent = `${path} (binary)`;
    updateControls();
  }
}

function workspaceTools(workspace: ProjectWorkspace): readonly WorkspaceTool[] {
  const basic = createWorkspaceTools(workspace);
  const project = createProjectWorkspaceTools(workspace);
  return Object.freeze([
    ...basic,
    project.stat,
    project.createDirectory,
    project.move,
    project.remove,
    project.applyPatch,
  ]);
}

function sessionFor(workspace: ProjectWorkspace): CodingSession {
  if (codingSession !== undefined) return codingSession;
  const model = modelInput.value.trim();
  if (model === '') throw new Error('Model is required.');
  codingSession = createCodingSession({
    id: RUN_SESSION_ID,
    model: createCodexExperimentalModel({
      model,
      wireProtocol: model.startsWith('gpt-5.6') ? 'responses-lite' : 'classic',
      transport: createExtensionModelTransport(extensionRuntime(), selectedExtensionId()),
    }),
    tools: workspaceTools(workspace),
    configuration: {
      maxTurns: 12,
      instructions:
        'Complete the coding request accurately. Inspect files before editing. Prefer exact unified patches for existing text files. Never remove directories recursively unless the user explicitly requested it.',
    },
  });
  return codingSession;
}

async function runAgent(): Promise<void> {
  runButton.disabled = true;
  checkAuthButton.disabled = true;
  cancelRunButton.disabled = false;
  try {
    const workspace = await ensureWorkspace();
    const prompt = promptInput.value.trim();
    if (prompt === '') throw new Error('Agent request is required.');
    const session = sessionFor(workspace);
    setStatus('Running the model through the extension…');
    const events =
      session.transcript.length === 0 ? session.submit(prompt) : session.followUp(prompt);
    for await (const event of events) appendLog(describeEvent(event));
    await persistOpfsWorkspace();
    await renderFiles();
    setStatus('Run complete.');
  } catch (error) {
    appendLog(`Error: ${errorMessage(error)}`);
    setStatus('Run failed. See the sanitized event log.');
  } finally {
    checkAuthButton.disabled = false;
    cancelRunButton.disabled = true;
    updateControls();
  }
}

function excludedRuntimePath(path: string): boolean {
  return path
    .split('/')
    .some((segment) =>
      ['node_modules', '.venv', '__pycache__', '.pytest_cache', '.cache'].includes(segment),
    );
}

function executionWorkspace(workspace: ProjectWorkspace): BrowserExecutionWorkspace {
  return Object.freeze({
    async load() {
      const entries = await snapshotWorkspace(workspace);
      return Object.freeze({
        directories: entries
          .filter((entry) => entry.kind === 'directory' && !excludedRuntimePath(entry.path))
          .map((entry) => entry.path),
        files: entries.flatMap((entry) =>
          entry.kind === 'file' && !excludedRuntimePath(entry.path)
            ? [{ path: entry.path, data: entry.content }]
            : [],
        ),
      });
    },
    async commit(project: BrowserExecutionProject) {
      const desiredDirectories = new Set(
        (project.directories ?? []).filter((path) => !excludedRuntimePath(path)),
      );
      const desiredFiles = new Map(
        project.files
          .filter((file) => !excludedRuntimePath(file.path))
          .map((file) => [file.path, file.data] as const),
      );
      const current = await snapshotWorkspace(workspace);
      for (const entry of [...current].sort(
        (left, right) => right.path.length - left.path.length,
      )) {
        const keep =
          entry.kind === 'directory'
            ? desiredDirectories.has(entry.path)
            : desiredFiles.has(entry.path);
        if (!keep && !excludedRuntimePath(entry.path)) {
          await workspace.remove(
            entry.path,
            entry.kind === 'directory' ? { recursive: true } : undefined,
          );
        }
      }
      const entries: WorkspaceImportEntry[] = [
        ...[...desiredDirectories].map((path) => ({ path, kind: 'directory' as const })),
        ...[...desiredFiles].map(([path, content]) => ({ path, kind: 'file' as const, content })),
      ];
      await importWorkspaceEntries(workspace, entries, { overwrite: true });
    },
  });
}

function commandParts(value: string): readonly string[] {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  return parts.map((part) => {
    const quoted =
      (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1) : part;
  });
}

async function runCommand(): Promise<void> {
  const workspace = await ensureWorkspace();
  const runtime = executionRuntimes[runtimeSelect.value];
  if (runtime === undefined) throw new Error('Unknown browser runtime.');
  const [command, ...arguments_] = commandParts(commandInput.value.trim());
  if (command === undefined) throw new Error('Enter a command.');
  if (
    activeWorkspaceMode === 'direct' &&
    !globalThis.confirm(
      'Allow this browser runtime to write changes back to the selected directory?',
    )
  )
    return;
  runtimeOutput.textContent = '';
  runtimeCancellation = createCancellationSource();
  runCommandButton.disabled = true;
  cancelRunButton.disabled = false;
  try {
    const result = await executeBrowserWorkspace(
      runtime,
      executionWorkspace(workspace),
      { command, arguments: arguments_, timeoutMs: 60_000 },
      {
        signal: runtimeCancellation.signal,
        onOutput: ({ chunk }) => appendRuntimeOutput(chunk),
      },
    );
    appendRuntimeOutput(`\nProcess exited with code ${String(result.exitCode)}.\n`);
    await persistOpfsWorkspace();
    await renderFiles();
  } finally {
    runtimeCancellation = undefined;
    cancelRunButton.disabled = true;
    updateControls();
  }
}

checkAuthButton.addEventListener('click', () => {
  void refreshAuthenticationStatus().catch((error: unknown) => {
    authenticated = false;
    updateControls();
    setStatus(`Connection failed: ${errorMessage(error)}`);
  });
});

logoutButton.addEventListener('click', () => {
  logoutButton.disabled = true;
  void authProvider()
    .logout()
    .then(async () => {
      await disposeCodingSession();
      return refreshAuthenticationStatus();
    })
    .catch((error: unknown) => setStatus(`Logout failed: ${errorMessage(error)}`));
});

runButton.addEventListener('click', () => void runAgent());
cancelRunButton.addEventListener('click', () => {
  codingSession?.cancel(new Error('Cancelled by user.'));
  runtimeCancellation?.cancel(new Error('Cancelled by user.'));
});
openWorkspaceButton.addEventListener('click', () => {
  void openWorkspace().catch((error: unknown) =>
    setStatus(`Workspace failed: ${errorMessage(error)}`),
  );
});
workspaceMode.addEventListener('change', () => {
  activeWorkspace = undefined;
  activeWorkspaceMode = undefined;
  selectedFile = undefined;
  void disposeCodingSession()
    .then(() => renderFiles())
    .then(updateControls);
});
importFolderButton.addEventListener('click', () => folderInput.click());
importZipButton.addEventListener('click', () => zipInput.click());
folderInput.addEventListener('change', () => {
  void (async () => {
    const workspace = await ensureWorkspace();
    await importBrowserFolderFiles(workspace, Array.from(folderInput.files ?? []), {
      overwrite: true,
    });
    await persistOpfsWorkspace();
    await renderFiles();
    setStatus('Folder imported.');
  })().catch((error: unknown) => setStatus(`Folder import failed: ${errorMessage(error)}`));
});
zipInput.addEventListener('change', () => {
  void (async () => {
    const file = zipInput.files?.[0];
    if (file === undefined) return;
    const workspace = await ensureWorkspace();
    await importWorkspaceZip(workspace, new Uint8Array(await file.arrayBuffer()), {
      overwrite: true,
    });
    await persistOpfsWorkspace();
    await renderFiles();
    setStatus('ZIP imported.');
  })().catch((error: unknown) => setStatus(`ZIP import failed: ${errorMessage(error)}`));
});
exportZipButton.addEventListener('click', () => {
  void (async () => {
    const workspace = await ensureWorkspace();
    const blob = new Blob([ownedBuffer(await exportWorkspaceZip(workspace))], {
      type: 'application/zip',
    });
    const url = URL.createObjectURL(blob);
    const link = globalThis.document.createElement('a');
    link.href = url;
    link.download = 'loom-project.zip';
    link.click();
    URL.revokeObjectURL(url);
  })().catch((error: unknown) => setStatus(`ZIP export failed: ${errorMessage(error)}`));
});
saveFileButton.addEventListener('click', () => {
  void (async () => {
    if (activeWorkspace === undefined || selectedFile === undefined) return;
    await activeWorkspace.writeFile(selectedFile, editor.value);
    await persistOpfsWorkspace();
    setStatus(`${selectedFile} saved.`);
  })().catch((error: unknown) => setStatus(`Save failed: ${errorMessage(error)}`));
});
runCommandButton.addEventListener('click', () => {
  void runCommand().catch((error: unknown) => {
    appendRuntimeOutput(`Error: ${errorMessage(error)}\n`);
    updateControls();
  });
});
runtimeSelect.addEventListener('change', () => {
  commandInput.value =
    runtimeSelect.value === 'python'
      ? 'python main.py'
      : runtimeSelect.value === 'node'
        ? 'node index.js'
        : 'quickjs main.js';
});
modelInput.addEventListener('change', () => void disposeCodingSession());
extensionIdInput.addEventListener('change', () => void disposeCodingSession());

updateControls();
