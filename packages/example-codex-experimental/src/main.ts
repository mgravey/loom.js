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
  type CodexResponsesFetch,
  type CodexResponsesHttpResponse,
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
const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const DIRECT_AUTH_PROTOCOL = 'loom/codex-direct-auth-experimental';
const DIRECT_AUTH_VERSION = 1;
const ORIGIN_ACCESS_PROTOCOL = 'loom/codex-origin-access-experimental';
const ORIGIN_ACCESS_VERSION = 1;
const MODEL_PORT_NAME = 'loom/codex-model-experimental/v1';
const MODEL_PROTOCOL = 'loom/codex-model-experimental';
const MODEL_PROTOCOL_VERSION = 1;
const RUN_SESSION_ID = sessionId('codex-experimental-browser-run');
const OPFS_DIRECTORY = 'loom-workbench';
const OPFS_ARCHIVE = 'project.zip';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const EXTENSION_ID_STORAGE_KEY = 'loom.chrome-extension-id';
const MODEL_TRANSPORT_STORAGE_PREFIX = 'loom.codex-model-transport.';

interface LoomDeploymentConfig {
  readonly chromeExtensionId?: string;
}

interface DirectoryPickerHost {
  showDirectoryPicker(options?: {
    readonly mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

interface DirectCredentials {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAt: number;
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

interface RelayRuntime extends ExternalMessageRuntime {
  connect(extensionId: string, options: { readonly name: string }): ExternalPort;
}

class DirectProviderConnectionError extends Error {
  constructor(cause: unknown) {
    super('The direct provider request failed before an HTTP response.', { cause });
    this.name = 'DirectProviderConnectionError';
  }
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
const logElement = requiredElement('#log', HTMLDivElement);
const transportStatusElement = requiredElement('#transport-status', HTMLSpanElement);
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

function appendLog(message: string, tone: 'assistant' | 'error' | 'system' = 'system'): void {
  const entry = globalThis.document.createElement('div');
  entry.className = `chat-message ${tone}`;
  entry.textContent = message;
  logElement.append(entry);
  logElement.scrollTop = logElement.scrollHeight;
}

function appendUserMessage(message: string): void {
  appendLog(message, 'assistant');
  logElement.lastElementChild?.classList.add('user');
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

function providerDiagnostic(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:[\]-]{1,256}$/u.test(value)
    ? value
    : 'unclassified';
}

function extensionRuntime(): RelayRuntime {
  const runtime = (
    globalThis as typeof globalThis & {
      readonly chrome?: { readonly runtime?: RelayRuntime };
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

let nextDirectAuthRequest = 0;
let nextOriginAccessRequest = 0;
let nextRelayRequest = 0;
let cachedDirectCredentials: Promise<DirectCredentials> | undefined;
let modelTransportMode: 'direct' | 'relay' = 'direct';

function setTransportMode(mode: 'direct' | 'relay'): void {
  modelTransportMode = mode;
  transportStatusElement.textContent = mode === 'direct' ? 'Direct preferred' : 'Extension relay';
  transportStatusElement.dataset.mode = mode;
  const extensionId = extensionIdInput.value.trim();
  if (!EXTENSION_ID_PATTERN.test(extensionId)) return;
  try {
    const key = `${MODEL_TRANSPORT_STORAGE_PREFIX}${extensionId}`;
    if (mode === 'relay') globalThis.sessionStorage.setItem(key, mode);
    else globalThis.sessionStorage.removeItem(key);
  } catch {
    // Tab-scoped transport affinity is an optimization; storage availability is optional.
  }
}

function storedTransportMode(): 'direct' | 'relay' {
  const extensionId = extensionIdInput.value.trim();
  if (!EXTENSION_ID_PATTERN.test(extensionId)) return 'direct';
  try {
    return globalThis.sessionStorage.getItem(`${MODEL_TRANSPORT_STORAGE_PREFIX}${extensionId}`) ===
      'relay'
      ? 'relay'
      : 'direct';
  } catch {
    return 'direct';
  }
}

function sendExtensionMessage(message: unknown): Promise<unknown> {
  const runtime = extensionRuntime();
  const extensionId = selectedExtensionId();
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: unknown): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const rejectOnce = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error('Extension request failed.'));
      }
    };
    try {
      const returned = runtime.sendMessage(extensionId, message, undefined, (response) => {
        if (runtime.lastError !== undefined) {
          rejectOnce(new Error(runtime.lastError.message ?? 'Extension request failed.'));
        } else {
          resolveOnce(response);
        }
      });
      if (
        returned !== null &&
        (typeof returned === 'object' || typeof returned === 'function') &&
        typeof (returned as PromiseLike<unknown>).then === 'function'
      ) {
        void Promise.resolve(returned as PromiseLike<unknown>).then(resolveOnce, rejectOnce);
      } else if (returned !== undefined) {
        resolveOnce(returned);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function requestDirectCredentials(): Promise<DirectCredentials> {
  nextDirectAuthRequest += 1;
  const requestId = `loom-direct-auth-${String(nextDirectAuthRequest)}`;
  pageDiagnostic('auth.credentials.request', { requestId });
  const response = await sendExtensionMessage({
    protocol: DIRECT_AUTH_PROTOCOL,
    version: DIRECT_AUTH_VERSION,
    type: 'getDirectCredentials',
    requestId,
    providerId: PROVIDER_ID,
  });
  if (
    !isRecord(response) ||
    response.protocol !== DIRECT_AUTH_PROTOCOL ||
    response.version !== DIRECT_AUTH_VERSION ||
    response.type !== 'getDirectCredentialsResult' ||
    response.requestId !== requestId ||
    response.ok !== true ||
    typeof response.accessToken !== 'string' ||
    response.accessToken.trim() === '' ||
    typeof response.accountId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,256}$/u.test(response.accountId)
  ) {
    const code =
      isRecord(response) && isRecord(response.error)
        ? providerDiagnostic(response.error.code)
        : 'INVALID_EXTENSION_RESPONSE';
    pageDiagnostic('auth.credentials.rejected', { requestId, code });
    throw new Error(`Extension direct authentication failed (${code}).`);
  }
  pageDiagnostic('auth.credentials.response', { requestId });
  return Object.freeze({
    accessToken: response.accessToken,
    accountId: response.accountId,
    expiresAt:
      typeof response.expiresAt === 'number' && Number.isFinite(response.expiresAt)
        ? response.expiresAt
        : Date.now() + 30_000,
  });
}

async function ensureOriginAccess(): Promise<void> {
  nextOriginAccessRequest += 1;
  const requestId = `loom-origin-access-${String(nextOriginAccessRequest)}`;
  pageDiagnostic('origin.access.request', { requestId });
  const response = await sendExtensionMessage({
    protocol: ORIGIN_ACCESS_PROTOCOL,
    version: ORIGIN_ACCESS_VERSION,
    type: 'requestOriginAccess',
    requestId,
  });
  if (
    !isRecord(response) ||
    response.protocol !== ORIGIN_ACCESS_PROTOCOL ||
    response.version !== ORIGIN_ACCESS_VERSION ||
    response.type !== 'originAccessResult' ||
    response.requestId !== requestId ||
    response.ok !== true ||
    typeof response.approved !== 'boolean'
  ) {
    const code =
      isRecord(response) && isRecord(response.error)
        ? providerDiagnostic(response.error.code)
        : 'INVALID_EXTENSION_RESPONSE';
    pageDiagnostic('origin.access.rejected', { requestId, code });
    throw new Error(`Extension website authorization failed (${code}).`);
  }
  pageDiagnostic('origin.access.response', { requestId, approved: response.approved });
  if (!response.approved) {
    throw new Error(
      'Approve this exact website origin in the extension options page, then check authentication again.',
    );
  }
}

async function directCredentials(): Promise<DirectCredentials> {
  if (cachedDirectCredentials !== undefined) {
    const cached = await cachedDirectCredentials;
    if (cached.expiresAt > Date.now() + 10_000) return cached;
  }
  cachedDirectCredentials = requestDirectCredentials();
  try {
    return await cachedDirectCredentials;
  } catch (error) {
    cachedDirectCredentials = undefined;
    throw error;
  }
}

async function providerErrorMetadata(
  response: Response,
): Promise<Readonly<Record<string, string>>> {
  let envelope: unknown;
  try {
    const text = (await response.text()).slice(0, 16 * 1024);
    envelope = JSON.parse(text);
  } catch {
    return Object.freeze({});
  }
  const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;
  if (error === undefined) return Object.freeze({});
  return Object.freeze({
    providerCode: providerDiagnostic(error.code),
    providerType: providerDiagnostic(error.type),
    providerParam: providerDiagnostic(error.param),
  });
}

function decodedResponseBody(
  body: ReadableStream<Uint8Array>,
  unsubscribe: () => void,
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const chunk = decoder.decode(result.value, { stream: true });
          if (chunk !== '') yield chunk;
        }
        const tail = decoder.decode();
        if (tail !== '') yield tail;
      } finally {
        unsubscribe();
        reader.releaseLock();
      }
    },
  };
}

const EMPTY_RESPONSE_BODY: AsyncIterable<string> = Object.freeze({
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => Promise.resolve({ done: true, value: undefined }),
    };
  },
});

const directModelFetch: CodexResponsesFetch = async (
  request,
): Promise<CodexResponsesHttpResponse> => {
  const controller = new AbortController();
  const unsubscribe = request.signal?.onCancel(() => controller.abort()) ?? (() => undefined);
  pageDiagnostic('model.fetch.started', { target: 'chatgpt.com', direct: true });
  const parsedBody: unknown = JSON.parse(request.body);
  if (!isRecord(parsedBody)) throw new Error('Direct model request body is invalid.');
  const body = JSON.stringify({
    ...parsedBody,
    prompt_cache_key: RUN_SESSION_ID,
    client_metadata: { session_id: RUN_SESSION_ID, thread_id: RUN_SESSION_ID },
  });
  let response: Response;
  try {
    response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
      signal: controller.signal,
    });
  } catch (error) {
    unsubscribe();
    if (controller.signal.aborted) throw error;
    throw new DirectProviderConnectionError(error);
  }
  pageDiagnostic('model.fetch.response', { status: response.status, direct: true });
  if (!response.ok) {
    const metadata = await providerErrorMetadata(response);
    unsubscribe();
    appendLog(
      `Provider rejected the request (${String(response.status)}): ${metadata.providerCode ?? 'unclassified'}; type ${metadata.providerType ?? 'unclassified'}; parameter ${metadata.providerParam ?? 'unclassified'}.`,
    );
    return Object.freeze({
      status: response.status,
      body: EMPTY_RESPONSE_BODY,
    });
  }
  if (response.body === null) {
    unsubscribe();
    throw new Error('Provider response body is unavailable.');
  }
  return Object.freeze({
    status: response.status,
    body: decodedResponseBody(response.body, unsubscribe),
  });
};

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

const relayModelFetch: CodexResponsesFetch = (request) => {
  nextRelayRequest += 1;
  const requestId = `loom-relay-${String(nextRelayRequest)}`;
  const port = extensionRuntime().connect(selectedExtensionId(), { name: MODEL_PORT_NAME });
  const stream = createChunkStream();
  let started = false;
  let ended = false;
  let settled = false;
  let unsubscribe = (): void => undefined;
  pageDiagnostic('model.relay.started', { requestId, target: 'chatgpt.com' });
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
        pageDiagnostic('model.relay.response', { requestId, status: message.status });
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
          `Provider rejected the relayed request (${String(message.status)}): ${providerDiagnostic(message.providerCode)}; type ${providerDiagnostic(message.providerType)}; parameter ${providerDiagnostic(message.providerParam)}.`,
        );
        return;
      }
      if (message.type === 'error') {
        unsubscribe();
        rejectOnce(new Error('Experimental extension relay failed.'));
      }
    });
    port.onDisconnect.addListener(() => {
      pageDiagnostic('model.relay.disconnect', { requestId, ended });
      unsubscribe();
      if (!ended) rejectOnce(new Error('Experimental extension relay disconnected.'));
    });
    if (request.signal !== undefined) {
      unsubscribe = request.signal.onCancel(() => {
        stream.fail(new Error('Experimental extension relay was cancelled.'));
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
      wireProtocol:
        request.headers['x-openai-internal-codex-responses-lite'] === 'true'
          ? 'responses-lite'
          : 'classic',
    });
  });
};

const directFirstModelFetch: CodexResponsesFetch = async (request) => {
  if (modelTransportMode === 'relay') return relayModelFetch(request);
  try {
    return await directModelFetch(request);
  } catch (error) {
    request.signal?.throwIfCancelled();
    if (!(error instanceof DirectProviderConnectionError)) throw error;
    setTransportMode('relay');
    pageDiagnostic('model.fetch.fallback', { reason: 'pre-response-failure' });
    return relayModelFetch(request);
  }
};

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
  runButton.setAttribute(
    'aria-label',
    hasWorkspace ? 'Send coding request' : 'Choose directory and send',
  );
}

async function refreshAuthenticationStatus(updateStatus = true): Promise<boolean> {
  await ensureOriginAccess();
  pageDiagnostic('auth.status.request');
  authenticated = await authProvider().isAuthenticated();
  if (!authenticated) cachedDirectCredentials = undefined;
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

const activeToolRows = new Map<string, HTMLDetailsElement>();
let activeAssistantMessage: HTMLDivElement | undefined;

function toolLabel(operation: string, input: Readonly<Record<string, unknown>>): string {
  const path = typeof input.path === 'string' ? ` ${input.path}` : '';
  if (operation === 'workspace/list-files') return `Inspecting workspace${path}`;
  if (operation === 'workspace/read-file') return `Reading${path}`;
  if (operation === 'workspace/write-file') return `Writing${path}`;
  if (operation === 'workspace/apply-patch') return `Applying changes${path}`;
  if (operation === 'workspace/stat') return `Inspecting${path}`;
  if (operation === 'workspace/create-directory') return `Creating folder${path}`;
  if (operation === 'workspace/move') return 'Moving workspace item';
  if (operation === 'workspace/remove') return `Removing${path}`;
  return 'Using workspace tool';
}

function isFailedToolResult(value: unknown): boolean {
  return isRecord(value) && value.ok === false;
}

function renderAgentEvent(event: CodexAgentEvent): void {
  if (event.type === 'text') {
    if (activeAssistantMessage === undefined) {
      activeAssistantMessage = globalThis.document.createElement('div');
      activeAssistantMessage.className = 'chat-message assistant';
      logElement.append(activeAssistantMessage);
    }
    activeAssistantMessage.textContent = `${activeAssistantMessage.textContent}${event.text}`;
    logElement.scrollTop = logElement.scrollHeight;
    return;
  }
  activeAssistantMessage = undefined;
  if (event.type === 'tool-start') {
    const row = globalThis.document.createElement('details');
    row.className = 'tool-activity';
    const summary = globalThis.document.createElement('summary');
    summary.textContent = toolLabel(event.operation, event.input);
    const detail = globalThis.document.createElement('pre');
    detail.textContent = JSON.stringify(
      { operation: event.operation, input: event.input },
      null,
      2,
    );
    row.append(summary, detail);
    activeToolRows.set(event.callId, row);
    logElement.append(row);
    logElement.scrollTop = logElement.scrollHeight;
    return;
  }
  if (event.type === 'tool-finish') {
    const row = activeToolRows.get(event.callId);
    if (row !== undefined) {
      row.classList.add(isFailedToolResult(event.result) ? 'failed' : 'complete');
      const summary = row.querySelector('summary');
      if (summary !== null) {
        summary.textContent = `${summary.textContent} ${
          isFailedToolResult(event.result) ? '— retrying' : '— done'
        }`;
      }
      const detail = row.querySelector('pre');
      if (detail !== null) {
        detail.textContent = `${detail.textContent}\n\nResult\n${JSON.stringify(event.result, null, 2)}`;
      }
      activeToolRows.delete(event.callId);
    }
  }
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
      endpoint: CODEX_RESPONSES_ENDPOINT,
      authentication: async () => (await directCredentials()).accessToken,
      accountId: async () => (await directCredentials()).accountId,
      fetch: directFirstModelFetch,
      originator: 'loom_page_experiment',
      headers: {
        'session-id': RUN_SESSION_ID,
        'thread-id': RUN_SESSION_ID,
        version: 'loom.js/0.1.0',
      },
    }),
    tools: workspaceTools(workspace),
    configuration: {
      maxTurns: 12,
      instructions:
        'Complete the coding request accurately. Inspect files before editing. Prefer exact unified patches for existing text files. Tool failures are returned as structured results: inspect the error, re-read current content when needed, and retry with corrected input. Never remove directories recursively unless the user explicitly requested it.',
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
    appendUserMessage(prompt);
    promptInput.value = '';
    activeAssistantMessage = undefined;
    setStatus('Working…');
    const events =
      session.transcript.length === 0 ? session.submit(prompt) : session.followUp(prompt);
    for await (const event of events) renderAgentEvent(event);
    await persistOpfsWorkspace();
    await renderFiles();
    setStatus('Run complete.');
  } catch (error) {
    appendLog(errorMessage(error), 'error');
    setStatus('Run failed. You can revise the request and try again.');
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
      cachedDirectCredentials = undefined;
      await disposeCodingSession();
      return refreshAuthenticationStatus();
    })
    .catch((error: unknown) => setStatus(`Logout failed: ${errorMessage(error)}`));
});

runButton.addEventListener('click', () => void runAgent());
promptInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || runButton.disabled) return;
  event.preventDefault();
  void runAgent();
});
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
extensionIdInput.addEventListener('change', () => {
  cachedDirectCredentials = undefined;
  setTransportMode(storedTransportMode());
  void disposeCodingSession();
  if (EXTENSION_ID_PATTERN.test(extensionIdInput.value.trim())) {
    setStatus('Connecting to extension…');
    void refreshAuthenticationStatus().catch((error: unknown) => {
      authenticated = false;
      updateControls();
      setStatus(`Connection failed: ${errorMessage(error)}`);
    });
  }
});

setTransportMode(storedTransportMode());
updateControls();
if (EXTENSION_ID_PATTERN.test(extensionIdInput.value.trim())) {
  setStatus('Connecting to extension…');
  void refreshAuthenticationStatus().catch((error: unknown) => {
    authenticated = false;
    updateControls();
    setStatus(`Connection failed: ${errorMessage(error)}`);
  });
}
