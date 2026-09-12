import type { CodexAgentEvent, CodexAgentTool } from '@mgravey/loom-agent-codex';
import {
  createExternalCredentialBroker,
  createExtensionAuthProvider,
} from '@mgravey/loom-auth-extension';
import {
  createCodexExtensionFetch,
  requestCodexOriginAccess,
  type CodexCompanionRuntime,
} from '@mgravey/loom-companion-codex-experimental';
import { createCodingSession, type CodingSession } from '@mgravey/loom-coding';
import {
  createPyodideExecutionRuntime,
  createQuickJsExecutionRuntime,
  createWebContainerExecutionRuntime,
  executeBrowserWorkspace,
  type BrowserExecutionRuntime,
} from '@mgravey/loom-execution-browser';
import {
  createCodexExperimentalModel,
  type CodexReasoningEffort,
  type CodexResponsesFetch,
  type CodexResponsesHttpResponse,
} from '@mgravey/loom-model-codex-experimental';
import {
  OpenAIResponsesModelError,
  createOpenAICompatibleResponsesModel,
  type OpenAICompatibleResponsesFetch,
} from '@mgravey/loom-model-openai-responses';
import {
  createMemoryProjectWorkspace,
  createProjectWorkspaceTools,
  createWorkspaceTools,
  exportWorkspaceZip,
  importBrowserFolderFiles,
  importWorkspaceZip,
  snapshotWorkspace,
  workspacePath,
  type ProjectWorkspace,
  type WorkspacePath,
} from '@mgravey/loom-tool-workspace';
import { createCancellationSource, sessionId, type CancellationSource } from '@mgravey/loom-types';
import { createFileSystemAccessProjectWorkspace } from '@mgravey/loom-workspace-fsa';

import {
  BROWSER_INSTALL_PACKAGES_OPERATION,
  BROWSER_RUN_FILE_OPERATION,
  createBrowserExecutionWorkspace,
  createBrowserInstallPackagesTool,
  createBrowserRunFileTool,
  type WebsiteRuntimeId,
} from './browser-run-file-tool.js';
import {
  cleanLoomDirectory,
  createWorkspaceConversation,
  loadWorkspaceConversations,
  removeWorkspaceConversation,
  saveWorkspaceConversation,
  updateWorkspaceConversation,
  type WorkspaceConversation,
} from './conversation-store.js';
import {
  clearLocalModelApiKey,
  loadLocalModelConnection,
  loadWorkbenchProvider,
  openAICompatibleBaseUrl,
  openAICompatibleEndpoint,
  openAICompatibleModelIds,
  saveLocalModelConnection,
  saveWorkbenchProvider,
  type WorkbenchModelProvider,
} from './local-model-connection.js';

const PROVIDER_ID = 'openai/codex-experimental';
const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const DIRECT_AUTH_PROTOCOL = 'loom/codex-direct-auth-experimental';
const DIRECT_AUTH_VERSION = 1;
const DEFAULT_RUN_SESSION_ID = sessionId('codex-experimental-browser-run');
const OPFS_DIRECTORY = 'loom-workbench';
const OPFS_ARCHIVE = 'project.zip';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const EXTENSION_ID_STORAGE_KEY = 'loom.chrome-extension-id';
const LEGACY_DEVELOPMENT_EXTENSION_IDS = new Set(['foofdcgdelahbdgdfgocoeajdodhjbjo']);
const MODEL_TRANSPORT_STORAGE_PREFIX = 'loom.codex-model-transport.';

interface LoomDeploymentConfig {
  readonly environment?: string;
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
const thinkingLevelSelect = requiredElement('#thinking-level', HTMLSelectElement);
const refreshModelsButton = requiredElement('#refresh-models', HTMLButtonElement);
const availableModelsSelect = requiredElement('#available-models', HTMLSelectElement);
const savedThinkingLevel = globalThis.localStorage.getItem('loom.thinking-level') ?? '';
if (
  ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
    savedThinkingLevel,
  )
)
  thinkingLevelSelect.value = savedThinkingLevel;

const modelInput = requiredElement('#model', HTMLInputElement);
const modelProviderSelect = requiredElement('#model-provider', HTMLSelectElement);
const codexConnectionSettings = requiredElement('#codex-connection-settings', HTMLDivElement);
const localModelConnectionSettings = requiredElement(
  '#local-model-connection-settings',
  HTMLDivElement,
);
const localModelBaseUrlInput = requiredElement('#local-model-base-url', HTMLInputElement);
const localModelApiKeyInput = requiredElement('#local-model-api-key', HTMLInputElement);
const connectLocalModelButton = requiredElement('#connect-local-model', HTMLButtonElement);
const clearLocalModelKeyButton = requiredElement('#clear-local-model-key', HTMLButtonElement);
const localModelConnectionStatus = requiredElement(
  '#local-model-connection-status',
  HTMLParagraphElement,
);
const localModelList = requiredElement('#local-model-list', HTMLDataListElement);
const promptInput = requiredElement('#prompt', HTMLTextAreaElement);
const checkAuthButton = requiredElement('#check-auth', HTMLButtonElement);
const runButton = requiredElement('#run', HTMLButtonElement);
const cancelRunButton = requiredElement('#cancel-run', HTMLButtonElement);
const logoutButton = requiredElement('#logout', HTMLButtonElement);
const statusElement = requiredElement('#status', HTMLParagraphElement);
const logElement = requiredElement('#log', HTMLDivElement);
const transportStatusElement = requiredElement('#transport-status', HTMLSpanElement);
const activityStatusElement = requiredElement('#activity-status', HTMLSpanElement);
const workspaceMode = requiredElement('#workspace-mode', HTMLSelectElement);
const openWorkspaceButton = requiredElement('#open-workspace', HTMLButtonElement);
const allowReadInput = requiredElement('#allow-read', HTMLInputElement);
const allowWriteInput = requiredElement('#allow-write', HTMLInputElement);
const accessSummary = requiredElement('#access-summary', HTMLParagraphElement);
const importFolderButton = requiredElement('#import-folder', HTMLButtonElement);
const importZipButton = requiredElement('#import-zip', HTMLButtonElement);
const exportZipButton = requiredElement('#export-zip', HTMLButtonElement);
const folderInput = requiredElement('#folder-input', HTMLInputElement);
const zipInput = requiredElement('#zip-input', HTMLInputElement);
const fileList = requiredElement('#file-list', HTMLUListElement);
const conversationList = requiredElement('#conversation-list', HTMLUListElement);
const newConversationButton = requiredElement('#new-conversation', HTMLButtonElement);
const deleteConversationButton = requiredElement('#delete-conversation', HTMLButtonElement);
const cleanLoomButton = requiredElement('#clean-loom', HTMLButtonElement);
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

function initialExtensionId(): string {
  const query = queryExtensionId();
  if (query !== undefined) return query;

  const stored = storedExtensionId();
  const deployed = deploymentExtensionId();
  const environment = (
    globalThis as typeof globalThis & {
      readonly LOOM_DEPLOYMENT_CONFIG?: LoomDeploymentConfig;
    }
  ).LOOM_DEPLOYMENT_CONFIG?.environment;
  if (
    environment === 'production' &&
    deployed !== undefined &&
    stored !== undefined &&
    LEGACY_DEVELOPMENT_EXTENSION_IDS.has(stored)
  ) {
    return deployed;
  }
  return stored ?? deployed ?? '';
}

extensionIdInput.value = initialExtensionId();
const storedLocalModelConnection = loadLocalModelConnection(globalThis.localStorage);
localModelBaseUrlInput.value = storedLocalModelConnection.baseUrl;
localModelApiKeyInput.value = storedLocalModelConnection.apiKey;
modelProviderSelect.value = loadWorkbenchProvider(globalThis.localStorage);
if (modelProviderSelect.value === 'openai-compatible-responses') {
  modelInput.value = storedLocalModelConnection.model;
}
let codexModelSelection =
  modelProviderSelect.value === 'codex-experimental' ? modelInput.value : 'gpt-5.6-sol';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function setActivityStatus(state: 'idle' | 'working' | 'error', message: string): void {
  activityStatusElement.dataset.state = state;
  activityStatusElement.textContent = message;
}

function canReadWorkspace(): boolean {
  return allowReadInput.checked;
}

function canWriteWorkspace(): boolean {
  return allowReadInput.checked && allowWriteInput.checked;
}

function updateAccessSummary(): void {
  accessSummary.textContent = canWriteWorkspace()
    ? 'Read and write enabled'
    : canReadWorkspace()
      ? 'Read-only; runtime changes are discarded'
      : 'Project access disabled';
}

function appendInlineMarkdown(container: HTMLElement, value: string): void {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/gu;
  let offset = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index;
    if (index > offset) container.append(value.slice(offset, index));
    const token = match[0];
    const element = globalThis.document.createElement(token.startsWith('`') ? 'code' : 'strong');
    element.textContent = token.startsWith('`') ? token.slice(1, -1) : token.slice(2, -2);
    container.append(element);
    offset = index + token.length;
  }
  if (offset < value.length) container.append(value.slice(offset));
}

function markdownCodeBlock(source: string, language: string): HTMLElement {
  const block = globalThis.document.createElement('div');
  block.className = 'markdown-code';
  const header = globalThis.document.createElement('div');
  header.className = 'markdown-code-header';
  const label = globalThis.document.createElement('span');
  label.textContent = language === '' ? 'Code' : language === 'text' ? 'Output' : language;
  const copy = globalThis.document.createElement('button');
  copy.type = 'button';
  copy.className = 'markdown-code-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void globalThis.navigator.clipboard
      .writeText(source)
      .then(() => {
        copy.textContent = 'Copied';
        globalThis.setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1_500);
      })
      .catch(() => {
        copy.textContent = 'Unavailable';
      });
  });
  const pre = globalThis.document.createElement('pre');
  const code = globalThis.document.createElement('code');
  code.textContent = source;
  pre.append(code);
  header.append(label, copy);
  block.append(header, pre);
  return block;
}

function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const fence = /^```([^`\s]*)\s*$/u.exec(line);
    if (fence !== null) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      container.append(markdownCodeBlock(codeLines.join('\n'), fence[1] ?? ''));
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const element = globalThis.document.createElement(`h${String(level + 1)}`);
      appendInlineMarkdown(element, heading[2] ?? '');
      container.append(element);
      index += 1;
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/u.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered !== null || ordered !== null) {
      const list = globalThis.document.createElement(unordered === null ? 'ol' : 'ul');
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const item =
          unordered === null
            ? /^\d+[.)]\s+(.+)$/u.exec(candidate)
            : /^[-*]\s+(.+)$/u.exec(candidate);
        if (item === null) break;
        const listItem = globalThis.document.createElement('li');
        appendInlineMarkdown(listItem, item[1] ?? '');
        list.append(listItem);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] ?? '';
      if (
        candidate.trim() === '' ||
        candidate.startsWith('```') ||
        /^(?:#{1,3}\s+|[-*]\s+|\d+[.)]\s+)/u.test(candidate)
      ) {
        break;
      }
      paragraphLines.push(candidate.trim());
      index += 1;
    }
    const paragraph = globalThis.document.createElement('p');
    appendInlineMarkdown(paragraph, paragraphLines.join(' '));
    container.append(paragraph);
  }
}

function appendLog(message: string, tone: 'assistant' | 'error' | 'system' = 'system'): void {
  const entry = globalThis.document.createElement('div');
  entry.className = `chat-message ${tone}`;
  if (tone === 'assistant') renderMarkdown(entry, message);
  else entry.textContent = message;
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
  if (error instanceof OpenAIResponsesModelError) {
    if (error.code === 'TRANSPORT_FAILED') {
      return 'The model server could not be reached. Check its address, CORS allowlist, network binding, and browser mixed-content policy.';
    }
    if (error.code === 'AUTHENTICATION_FAILED' || error.status === 401 || error.status === 403) {
      return 'The model server rejected authentication. Check or clear the configured API key.';
    }
    if (error.status === 404) {
      return 'The model server does not expose the expected /v1/responses endpoint.';
    }
    if (error.code === 'HTTP_ERROR') {
      return `The model server rejected the request${error.status === undefined ? '.' : ` with HTTP ${String(error.status)}.`}`;
    }
    if (error.code === 'MALFORMED_RESPONSE') {
      return 'The model server returned an invalid Responses JSON or SSE payload.';
    }
    if (error.code === 'INCOMPLETE_RESPONSE') {
      return 'The model server ended the response before it completed.';
    }
    if (error.code === 'PROVIDER_ERROR') {
      return 'The model server reported a response failure.';
    }
  }
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

function extensionRuntime(): CodexCompanionRuntime {
  const runtime = (
    globalThis as typeof globalThis & {
      readonly chrome?: { readonly runtime?: CodexCompanionRuntime };
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
let cachedDirectCredentials: Promise<DirectCredentials> | undefined;
let modelTransportMode: 'direct' | 'relay' = 'direct';

function setTransportMode(mode: 'direct' | 'relay'): void {
  modelTransportMode = mode;
  if (selectedModelProvider() === 'openai-compatible-responses') {
    transportStatusElement.textContent = 'Direct model server';
    transportStatusElement.dataset.mode = 'local';
    return;
  }
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
  const status = await requestCodexOriginAccess({
    extensionId: selectedExtensionId,
    runtime: extensionRuntime,
    diagnosticSink(event) {
      pageDiagnostic(event.event, {
        stage: event.stage,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.code === undefined ? {} : { code: event.code }),
      });
    },
  });
  if (!status.approved) {
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
    prompt_cache_key: currentRunSessionId(),
    client_metadata: {
      session_id: currentRunSessionId(),
      thread_id: currentRunSessionId(),
    },
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

const relayModelFetch = createCodexExtensionFetch({
  extensionId: selectedExtensionId,
  runtime: extensionRuntime,
  sessionId: currentRunSessionId,
  threadId: currentRunSessionId,
  diagnosticSink(event) {
    pageDiagnostic(event.event, {
      stage: event.stage,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.characters === undefined ? {} : { characters: event.characters }),
    });
  },
});

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

function assertLocalEndpointUsable(baseUrl: string): string {
  const normalized = openAICompatibleBaseUrl(baseUrl);
  if (globalThis.location.protocol === 'https:' && new URL(normalized).protocol === 'http:') {
    throw new Error(
      'An HTTPS workbench cannot connect to an HTTP model server. Use the locally served HTTP workbench or enable HTTPS on the model server.',
    );
  }
  return normalized;
}

function currentLocalModelSettings() {
  return Object.freeze({
    baseUrl: assertLocalEndpointUsable(localModelBaseUrlInput.value),
    model: modelInput.value.trim(),
    apiKey: localModelApiKeyInput.value,
  });
}

function persistLocalModelSettings(): ReturnType<typeof currentLocalModelSettings> {
  const settings = currentLocalModelSettings();
  saveLocalModelConnection(globalThis.localStorage, settings);
  localModelBaseUrlInput.value = settings.baseUrl;
  return settings;
}

function renderDiscoveredModels(models: readonly string[]): void {
  availableModelsSelect.replaceChildren(
    new Option('Select a model', ''),
    ...models.map((model) => new Option(model, model)),
  );
  localModelList.replaceChildren(
    ...models.map((model) => {
      const option = globalThis.document.createElement('option');
      option.value = model;
      return option;
    }),
  );
}

async function refreshModels(): Promise<void> {
  refreshModelsButton.disabled = true;
  const provider = selectedModelProvider();
  renderDiscoveredModels([]);
  try {
    if (provider === 'openai-compatible-responses') {
      await discoverLocalModels();
      return;
    }
    const credentials = await directCredentials();
    const response = await globalThis.fetch(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.1.0',
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credentials.accessToken}`,
          'ChatGPT-Account-Id': credentials.accountId,
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        mode: 'cors',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Model discovery returned HTTP ${String(response.status)}.`);
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models))
      throw new Error('Invalid Codex model list.');
    const models = openAICompatibleModelIds({
      data: value.models.map((entry: unknown) => ({
        id: isRecord(entry) ? entry.slug : undefined,
      })),
    });
    if (selectedModelProvider() !== provider) return;
    renderDiscoveredModels(models);
    setStatus(`Discovered ${String(models.length)} Codex models.`);
  } catch {
    setStatus('Model discovery unavailable. Check the connection or enter a model ID manually.');
  } finally {
    refreshModelsButton.disabled = false;
  }
}

async function discoverLocalModels(): Promise<void> {
  localModelConnected = false;
  connectLocalModelButton.disabled = true;
  localModelConnectionStatus.textContent = 'Connecting and discovering models…';
  setActivityStatus('working', 'Connecting model server');
  const settings = persistLocalModelSettings();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (settings.apiKey !== '') headers.Authorization = `Bearer ${settings.apiKey}`;
  let response: Response;
  try {
    response = await globalThis.fetch(openAICompatibleEndpoint(settings.baseUrl, 'models'), {
      method: 'GET',
      headers,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
    });
  } catch {
    localModelConnected = true;
    localModelConnectionStatus.textContent =
      'Model discovery was unavailable. Enter the exact model ID; the first run will test the Responses endpoint.';
    setStatus('Connected configuration saved; model discovery was unavailable.');
    setActivityStatus('idle', 'Manual model ID');
    return;
  } finally {
    connectLocalModelButton.disabled = false;
    updateControls();
  }
  localModelConnected = true;
  if (!response.ok) {
    localModelConnectionStatus.textContent = `Model discovery returned HTTP ${String(response.status)}. Enter the exact model ID to continue.`;
    setStatus('Connected configuration saved; enter a model ID manually.');
    setActivityStatus('idle', 'Manual model ID');
    updateControls();
    return;
  }
  const source = await response.text();
  if (source.length > 1024 * 1024) {
    localModelConnected = false;
    throw new Error('Model discovery response is too large.');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    localModelConnected = false;
    throw new Error('Model discovery returned invalid JSON.');
  }
  const models = openAICompatibleModelIds(value);
  renderDiscoveredModels(models);
  if (modelInput.value.trim() === '' && models[0] !== undefined) modelInput.value = models[0];
  persistLocalModelSettings();
  localModelConnectionStatus.textContent =
    models.length === 0
      ? 'Connected. No models were listed; enter the exact model ID.'
      : `Connected. Discovered ${String(models.length)} model${models.length === 1 ? '' : 's'}.`;
  setStatus('OpenAI-compatible model server connected.');
  setActivityStatus('idle', 'Ready');
  updateControls();
}

const openAICompatibleModelFetch: OpenAICompatibleResponsesFetch = async (request) => {
  const controller = new AbortController();
  const unsubscribe = request.signal?.onCancel(() => controller.abort()) ?? (() => undefined);
  pageDiagnostic('local-model.fetch.started', { direct: true });
  let response: Response;
  try {
    response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
      signal: controller.signal,
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  pageDiagnostic('local-model.fetch.response', { status: response.status, direct: true });
  const contentType = response.headers.get('content-type') ?? undefined;
  if (!response.ok) {
    unsubscribe();
    return Object.freeze({
      status: response.status,
      ...(contentType === undefined ? {} : { contentType }),
      body: '',
    });
  }
  if (response.body === null) {
    unsubscribe();
    throw new Error('Model server response body is unavailable.');
  }
  return Object.freeze({
    status: response.status,
    ...(contentType === undefined ? {} : { contentType }),
    body: decodedResponseBody(response.body, unsubscribe),
  });
};

function authProvider() {
  const broker = createExternalCredentialBroker({
    extensionId: selectedExtensionId(),
    runtime: extensionRuntime(),
  });
  return createExtensionAuthProvider({ broker, providerId: PROVIDER_ID });
}

let authenticated = false;
let localModelConnected = false;
let activeWorkspace: ProjectWorkspace | undefined;
let activeWorkspaceMode: 'direct' | 'memory' | 'opfs' | undefined;
let codingSession: CodingSession | undefined;
let selectedFile: WorkspacePath | undefined;
let conversations: readonly WorkspaceConversation[] = Object.freeze([]);
let activeConversation: WorkspaceConversation | undefined;

function currentRunSessionId() {
  return activeConversation === undefined
    ? DEFAULT_RUN_SESSION_ID
    : sessionId(`loom-${activeConversation.id}`);
}
let runtimeCancellation: CancellationSource | undefined;

function selectedModelProvider(): WorkbenchModelProvider {
  return modelProviderSelect.value === 'openai-compatible-responses'
    ? 'openai-compatible-responses'
    : 'codex-experimental';
}

function modelConnectionReady(): boolean {
  return selectedModelProvider() === 'openai-compatible-responses'
    ? localModelConnected && modelInput.value.trim() !== ''
    : authenticated;
}

const executionRuntimes: Readonly<Record<WebsiteRuntimeId, BrowserExecutionRuntime>> =
  Object.freeze({
    quickjs: createQuickJsExecutionRuntime(),
    node: createWebContainerExecutionRuntime({ coep: 'credentialless' }),
    python: createPyodideExecutionRuntime({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/',
    }),
  });

function updateControls(): void {
  const hasWorkspace = activeWorkspace !== undefined;
  const readable = canReadWorkspace();
  const writable = canWriteWorkspace();
  const busy = codingSession?.state === 'running' || runtimeCancellation !== undefined;
  thinkingLevelSelect.disabled = busy;
  availableModelsSelect.disabled = busy;
  runButton.disabled = !modelConnectionReady() || !readable;
  logoutButton.disabled = selectedModelProvider() !== 'codex-experimental' || !authenticated;
  openWorkspaceButton.disabled = !readable || busy;
  importFolderButton.disabled = !writable;
  importZipButton.disabled = !writable;
  exportZipButton.disabled = !hasWorkspace || !readable;
  runCommandButton.disabled = !hasWorkspace || !readable;
  editor.disabled = selectedFile === undefined || !readable;
  saveFileButton.disabled = selectedFile === undefined || !writable;
  newConversationButton.disabled = !hasWorkspace || !writable || busy;
  deleteConversationButton.disabled = activeConversation === undefined || !writable || busy;
  cleanLoomButton.disabled = !hasWorkspace || !writable || busy;
  for (const button of Array.from(conversationList.querySelectorAll('button'))) {
    button.disabled = busy;
  }
  allowReadInput.disabled = busy;
  allowWriteInput.disabled = !readable || busy;
  updateAccessSummary();
  runButton.setAttribute(
    'aria-label',
    hasWorkspace ? 'Send coding request' : 'Choose directory and send',
  );
}

function updateModelProviderView(): void {
  const local = selectedModelProvider() === 'openai-compatible-responses';
  codexConnectionSettings.hidden = local;
  localModelConnectionSettings.hidden = !local;
  extensionIdInput.required = !local;
  if (local) {
    transportStatusElement.textContent = 'Direct model server';
    transportStatusElement.dataset.mode = 'local';
    setActivityStatus(
      localModelConnected ? 'idle' : 'error',
      localModelConnected ? 'Ready' : 'Connect server',
    );
  } else {
    setTransportMode(modelTransportMode);
    setActivityStatus(
      authenticated ? 'idle' : 'error',
      authenticated ? 'Ready' : 'Sign-in required',
    );
  }
  updateControls();
}

async function refreshAuthenticationStatus(updateStatus = true): Promise<boolean> {
  setActivityStatus('working', 'Connecting extension');
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
  setActivityStatus(authenticated ? 'idle' : 'error', authenticated ? 'Ready' : 'Sign-in required');
  return authenticated;
}

const activeToolRows = new Map<string, HTMLDetailsElement>();
let activeAssistantMessage: HTMLDivElement | undefined;
let activeAssistantText = '';

interface ToolPresentation {
  readonly title: string;
  readonly description: string;
}

function toolPresentation(
  operation: string,
  input: Readonly<Record<string, unknown>>,
): ToolPresentation {
  const path = typeof input.path === 'string' ? input.path : undefined;
  const location = path === undefined || path === '' ? 'the project root' : `“${path}”`;
  if (operation === 'workspace/list-files') {
    return {
      title: `Explore ${location}`,
      description: 'Lists the files and folders available to the agent.',
    };
  }
  if (operation === 'workspace/read-file') {
    return {
      title: `Read ${location}`,
      description: 'Loads the current text so the agent can inspect it before editing.',
    };
  }
  if (operation === 'workspace/write-file') {
    return {
      title: `Write ${location}`,
      description: 'Creates the text file or replaces its complete contents.',
    };
  }
  if (operation === 'workspace/apply-patch') {
    return {
      title: `Edit ${location}`,
      description:
        'Applies an exact-context patch; a mismatch is returned for correction and retry.',
    };
  }
  if (operation === 'workspace/stat') {
    return {
      title: `Inspect ${location}`,
      description:
        'Checks whether the item exists and reads its type, size, and modification time.',
    };
  }
  if (operation === 'workspace/create-directory') {
    return {
      title: `Create folder ${location}`,
      description: 'Creates a project directory without exposing anything outside the workspace.',
    };
  }
  if (operation === 'workspace/move') {
    const source = typeof input.source === 'string' ? `“${input.source}”` : 'a project item';
    const destination =
      typeof input.destination === 'string' ? `“${input.destination}”` : 'a new location';
    return {
      title: `Move ${source} to ${destination}`,
      description: 'Renames or relocates a file or folder inside the project.',
    };
  }
  if (operation === 'workspace/remove') {
    return {
      title: `Remove ${location}`,
      description:
        'Deletes the selected workspace item; recursive removal requires explicit input.',
    };
  }
  if (operation === BROWSER_RUN_FILE_OPERATION) {
    const runtime = typeof input.runtime === 'string' ? input.runtime : 'browser';
    return {
      title: `Run ${location} with ${runtime}`,
      description:
        'Executes the file in the real isolated browser runtime and captures its exit code, stdout, and stderr.',
    };
  }
  if (operation === BROWSER_INSTALL_PACKAGES_OPERATION) {
    const runtime = typeof input.runtime === 'string' ? input.runtime : 'browser';
    const packages = Array.isArray(input.packages)
      ? input.packages.filter((item): item is string => typeof item === 'string').join(', ')
      : 'packages';
    return {
      title: `Install ${packages} for ${runtime}`,
      description:
        runtime === 'python'
          ? 'Uses micropip to add compatible Pyodide or PyPI wheel packages to the live Python runtime.'
          : 'Uses npm and records dependency metadata so later Node runs restore the packages.',
    };
  }
  return {
    title: `Use ${operation}`,
    description: 'Runs a tool registered by this website with schema-validated input.',
  };
}

function toolExitCode(value: unknown): number | undefined {
  return isRecord(value) && typeof value.exitCode === 'number' ? value.exitCode : undefined;
}

function isFailedToolResult(value: unknown): boolean {
  const exitCode = toolExitCode(value);
  return isRecord(value) && (value.ok === false || (exitCode !== undefined && exitCode !== 0));
}

function toolArtifacts(
  value: unknown,
): readonly { readonly path: string; readonly mediaType: string }[] {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) return [];
  return value.artifacts.flatMap((artifact) =>
    isRecord(artifact) &&
    typeof artifact.path === 'string' &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/')
      ? [{ path: artifact.path, mediaType: artifact.mediaType }]
      : [],
  );
}

async function appendToolArtifacts(row: HTMLDetailsElement, result: unknown): Promise<void> {
  const workspace = activeWorkspace;
  if (workspace === undefined) return;
  const artifacts = toolArtifacts(result);
  if (artifacts.length === 0) return;
  const gallery = globalThis.document.createElement('div');
  gallery.className = 'tool-artifacts';
  for (const artifact of artifacts) {
    const figure = globalThis.document.createElement('figure');
    const image = globalThis.document.createElement('img');
    const data = await workspace.readBytes(workspacePath(artifact.path));
    const source = URL.createObjectURL(new Blob([ownedBuffer(data)], { type: artifact.mediaType }));
    image.src = source;
    image.alt = `Generated figure ${artifact.path}`;
    image.addEventListener('load', () => URL.revokeObjectURL(source), { once: true });
    image.addEventListener('error', () => URL.revokeObjectURL(source), { once: true });
    const caption = globalThis.document.createElement('figcaption');
    caption.textContent = artifact.path;
    figure.append(image, caption);
    gallery.append(figure);
  }
  row.insertAdjacentElement('afterend', gallery);
}

async function renderAgentEvent(event: CodexAgentEvent): Promise<void> {
  if (event.type === 'text') {
    setActivityStatus('working', 'Writing response');
    if (activeAssistantMessage === undefined) {
      activeAssistantMessage = globalThis.document.createElement('div');
      activeAssistantMessage.className = 'chat-message assistant';
      activeAssistantText = '';
      logElement.append(activeAssistantMessage);
    }
    activeAssistantText += event.text;
    renderMarkdown(activeAssistantMessage, activeAssistantText);
    logElement.scrollTop = logElement.scrollHeight;
    return;
  }
  activeAssistantMessage = undefined;
  activeAssistantText = '';
  if (event.type === 'tool-start') {
    const presentation = toolPresentation(event.operation, event.input);
    setActivityStatus('working', presentation.title);
    const row = globalThis.document.createElement('details');
    row.className = 'tool-activity';
    const summary = globalThis.document.createElement('summary');
    const indicator = globalThis.document.createElement('span');
    indicator.className = 'tool-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const copy = globalThis.document.createElement('span');
    copy.className = 'tool-copy';
    const title = globalThis.document.createElement('span');
    title.className = 'tool-title';
    title.textContent = presentation.title;
    const description = globalThis.document.createElement('span');
    description.className = 'tool-description';
    description.textContent = presentation.description;
    copy.append(title, description);
    const state = globalThis.document.createElement('span');
    state.className = 'tool-state';
    state.textContent = 'Running';
    summary.append(indicator, copy, state);
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
      const state = row.querySelector('.tool-state');
      const exitCode = toolExitCode(event.result);
      if (state !== null) {
        state.textContent =
          exitCode === undefined
            ? isFailedToolResult(event.result)
              ? 'Needs retry'
              : 'Done'
            : `Exited ${String(exitCode)}`;
      }
      const detail = row.querySelector('pre');
      if (detail !== null) {
        detail.textContent = `${detail.textContent}\n\nResult\n${JSON.stringify(event.result, null, 2)}`;
      }
      await appendToolArtifacts(row, event.result);
      activeToolRows.delete(event.callId);
      setActivityStatus('working', 'Thinking');
    }
    return;
  }
  setActivityStatus('working', 'Finishing');
}

async function disposeCodingSession(): Promise<void> {
  if (codingSession !== undefined) await codingSession.dispose();
  codingSession = undefined;
}

function renderConversationHistory(): void {
  logElement.replaceChildren();
  activeToolRows.clear();
  activeAssistantMessage = undefined;
  activeAssistantText = '';
  if (activeConversation === undefined) return;
  modelProviderSelect.value = activeConversation.modelProvider;
  modelInput.value = activeConversation.model;
  saveWorkbenchProvider(globalThis.localStorage, activeConversation.modelProvider);
  updateModelProviderView();
  for (const entry of activeConversation.transcript) {
    if (entry.role === 'user') appendUserMessage(entry.content);
    else appendLog(entry.content, 'assistant');
  }
}

function sortedConversations(
  values: readonly WorkspaceConversation[],
): readonly WorkspaceConversation[] {
  return Object.freeze([...values].sort((left, right) => right.updatedAt - left.updatedAt));
}

function replaceConversation(conversation: WorkspaceConversation): void {
  conversations = sortedConversations([
    conversation,
    ...conversations.filter((candidate) => candidate.id !== conversation.id),
  ]);
  activeConversation = conversation;
}

function renderConversationList(): void {
  conversationList.replaceChildren();
  if (conversations.length === 0) {
    const item = globalThis.document.createElement('li');
    item.textContent = 'No saved conversations.';
    conversationList.append(item);
    updateControls();
    return;
  }
  for (const conversation of conversations) {
    const item = globalThis.document.createElement('li');
    const button = globalThis.document.createElement('button');
    button.type = 'button';
    button.textContent = conversation.title;
    button.title = conversation.title;
    button.setAttribute(
      'aria-current',
      conversation.id === activeConversation?.id ? 'true' : 'false',
    );
    button.addEventListener('click', () => {
      void selectConversation(conversation.id).catch((error: unknown) => {
        setStatus(`Conversation failed: ${errorMessage(error)}`);
      });
    });
    item.append(button);
    conversationList.append(item);
  }
  updateControls();
}

async function selectConversation(id: string): Promise<void> {
  const selected = conversations.find((conversation) => conversation.id === id);
  if (selected === undefined || selected.id === activeConversation?.id) return;
  await disposeCodingSession();
  activeConversation = selected;
  renderConversationHistory();
  renderConversationList();
  setStatus(`Conversation “${selected.title}” loaded.`);
}

async function loadConversationState(workspace: ProjectWorkspace): Promise<void> {
  await disposeCodingSession();
  conversations = await loadWorkspaceConversations(workspace);
  activeConversation = conversations[0];
  renderConversationHistory();
  renderConversationList();
}

async function createNewConversation(): Promise<void> {
  const workspace = activeWorkspace;
  if (workspace === undefined) throw new Error('Open a workspace first.');
  if (!canWriteWorkspace()) throw new Error('Enable workspace write access to save conversations.');
  await disposeCodingSession();
  const conversation = createWorkspaceConversation({
    model: modelInput.value.trim(),
    modelProvider: selectedModelProvider(),
  });
  await saveWorkspaceConversation(workspace, conversation);
  replaceConversation(conversation);
  renderConversationHistory();
  renderConversationList();
  await persistOpfsWorkspace();
  setStatus('New conversation created in .loom/conversations.');
}

async function persistActiveConversation(): Promise<void> {
  const workspace = activeWorkspace;
  const session = codingSession;
  const conversation = activeConversation;
  if (workspace === undefined || session === undefined || conversation === undefined) return;
  const updated = updateWorkspaceConversation(
    conversation,
    session.transcript,
    modelInput.value.trim(),
    selectedModelProvider(),
  );
  replaceConversation(updated);
  if (canWriteWorkspace()) await saveWorkspaceConversation(workspace, updated);
  renderConversationList();
}

async function deleteActiveConversation(): Promise<void> {
  const workspace = activeWorkspace;
  const conversation = activeConversation;
  if (workspace === undefined || conversation === undefined) return;
  if (!canWriteWorkspace()) throw new Error('Enable workspace write access first.');
  if (!globalThis.confirm(`Delete the conversation “${conversation.title}”?`)) return;
  await disposeCodingSession();
  await removeWorkspaceConversation(workspace, conversation.id);
  conversations = conversations.filter((candidate) => candidate.id !== conversation.id);
  activeConversation = conversations[0];
  renderConversationHistory();
  renderConversationList();
  await persistOpfsWorkspace();
  setStatus('Conversation deleted.');
}

async function cleanWorkspaceLoomDirectory(): Promise<void> {
  const workspace = activeWorkspace;
  if (workspace === undefined) return;
  if (!canWriteWorkspace()) throw new Error('Enable workspace write access first.');
  if (
    !globalThis.confirm(
      'Remove the entire .loom folder, including all saved conversations and generated figures?',
    )
  ) {
    return;
  }
  await disposeCodingSession();
  await cleanLoomDirectory(workspace);
  conversations = Object.freeze([]);
  activeConversation = undefined;
  renderConversationHistory();
  renderConversationList();
  await persistOpfsWorkspace();
  await renderFiles();
  setStatus('.loom was removed from the workspace.');
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
    const root = await directoryPicker()({ mode: canWriteWorkspace() ? 'readwrite' : 'read' });
    activeWorkspace = createFileSystemAccessProjectWorkspace(root);
    activeWorkspaceMode = 'direct';
  } else if (mode === 'opfs') {
    activeWorkspace = await loadOpfsWorkspace();
    activeWorkspaceMode = 'opfs';
  } else {
    activeWorkspace = createMemoryProjectWorkspace();
    activeWorkspaceMode = 'memory';
  }
  await loadConversationState(activeWorkspace);
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
  if (!canReadWorkspace()) {
    const item = globalThis.document.createElement('li');
    item.textContent = 'Read access disabled.';
    fileList.append(item);
    return;
  }
  const entries = await snapshotWorkspace(activeWorkspace);
  const files = entries.filter(
    (entry) => entry.kind === 'file' && !entry.path.startsWith('.loom/'),
  );
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
  if (activeWorkspace === undefined || !canReadWorkspace()) return;
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

function workspaceTools(workspace: ProjectWorkspace): readonly CodexAgentTool[] {
  const [listFiles, readFile, writeFile] = createWorkspaceTools(workspace);
  const project = createProjectWorkspaceTools(workspace);
  const browserToolOptions = {
    workspace,
    runtimes: executionRuntimes,
    writeBack: canWriteWorkspace(),
    persist: persistOpfsWorkspace,
  } as const;
  const tools: CodexAgentTool[] = [];
  if (canReadWorkspace()) tools.push(listFiles, readFile);
  if (canWriteWorkspace()) tools.push(writeFile);
  if (canReadWorkspace()) tools.push(project.stat);
  if (canWriteWorkspace())
    tools.push(project.createDirectory, project.move, project.remove, project.applyPatch);
  if (canReadWorkspace()) tools.push(createBrowserRunFileTool(browserToolOptions));
  if (canWriteWorkspace()) tools.push(createBrowserInstallPackagesTool(browserToolOptions));
  return Object.freeze(tools);
}

function sessionFor(workspace: ProjectWorkspace): CodingSession {
  if (codingSession !== undefined) return codingSession;
  const model = modelInput.value.trim();
  if (model === '') throw new Error('Model is required.');
  const reasoningOptions =
    thinkingLevelSelect.value === ''
      ? {}
      : { reasoningEffort: thinkingLevelSelect.value as CodexReasoningEffort };
  const runSessionId = currentRunSessionId();
  const provider = selectedModelProvider();
  const selectedModel =
    provider === 'openai-compatible-responses'
      ? (() => {
          if (!localModelConnected) throw new Error('Connect the model server before running.');
          const settings = persistLocalModelSettings();
          return createOpenAICompatibleResponsesModel({
            ...reasoningOptions,
            model,
            endpoint: openAICompatibleEndpoint(settings.baseUrl, 'responses'),
            fetch: openAICompatibleModelFetch,
            ...(settings.apiKey === ''
              ? {}
              : { authentication: () => Promise.resolve(settings.apiKey) }),
          });
        })()
      : createCodexExperimentalModel({
          ...reasoningOptions,
          model,
          wireProtocol: model.startsWith('gpt-5.6') ? 'responses-lite' : 'classic',
          endpoint: CODEX_RESPONSES_ENDPOINT,
          authentication: async () => (await directCredentials()).accessToken,
          accountId: async () => (await directCredentials()).accountId,
          fetch: directFirstModelFetch,
          originator: 'loom_page_experiment',
          headers: {
            'session-id': runSessionId,
            'thread-id': runSessionId,
            version: 'loom.js/0.1.0',
          },
        });
  codingSession = createCodingSession({
    id: runSessionId,
    transcript: activeConversation?.transcript ?? [],
    model: selectedModel,
    tools: workspaceTools(workspace),
    configuration: {
      maxTurns: 12,
      instructions:
        'Complete the coding request accurately. Inspect files before editing. Prefer exact unified patches for existing text files. When the user asks you to run or verify a .py file, call website/run-workspace-file with runtime python; Loom routes it to Pyodide automatically. Report only captured output and never extrapolate execution results. NumPy and Matplotlib are already loaded by default and must not be installed. Generated Matplotlib figures are returned as image artifacts. Install only genuinely missing Python or Node dependencies with website/install-runtime-packages before retrying. Tool failures are structured results: inspect the error, re-read current content when needed, and retry with corrected input. Never remove directories recursively unless the user explicitly requested it.',
    },
  });
  return codingSession;
}

async function runAgent(): Promise<void> {
  runButton.disabled = true;
  checkAuthButton.disabled = true;
  thinkingLevelSelect.disabled = true;
  availableModelsSelect.disabled = true;
  cancelRunButton.disabled = false;
  allowReadInput.disabled = true;
  allowWriteInput.disabled = true;
  try {
    const workspace = await ensureWorkspace();
    const prompt = promptInput.value.trim();
    if (prompt === '') throw new Error('Agent request is required.');
    if (activeConversation === undefined) {
      const conversation = createWorkspaceConversation({
        model: modelInput.value.trim(),
        modelProvider: selectedModelProvider(),
      });
      replaceConversation(conversation);
      if (canWriteWorkspace()) await saveWorkspaceConversation(workspace, conversation);
      renderConversationList();
    }
    const session = sessionFor(workspace);
    appendUserMessage(prompt);
    promptInput.value = '';
    activeAssistantMessage = undefined;
    activeAssistantText = '';
    setStatus('Working…');
    setActivityStatus('working', 'Thinking');
    const events =
      session.transcript.length === 0 ? session.submit(prompt) : session.followUp(prompt);
    for await (const event of events) await renderAgentEvent(event);
    await persistActiveConversation();
    await persistOpfsWorkspace();
    await renderFiles();
    setStatus('Run complete.');
    setActivityStatus('idle', 'Ready');
  } catch (error) {
    try {
      await persistActiveConversation();
      await persistOpfsWorkspace();
    } catch {
      // Preserve the original agent error; a later successful turn can retry persistence.
    }
    appendLog(errorMessage(error), 'error');
    setStatus('Run failed. You can revise the request and try again.');
    setActivityStatus('error', 'Needs attention');
  } finally {
    checkAuthButton.disabled = false;
    cancelRunButton.disabled = true;
    updateControls();
  }
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
  if (!canReadWorkspace()) throw new Error('Enable workspace read access before running code.');
  const workspace = await ensureWorkspace();
  const runtimeId = runtimeSelect.value;
  if (runtimeId !== 'quickjs' && runtimeId !== 'node' && runtimeId !== 'python') {
    throw new Error('Unknown browser runtime.');
  }
  const runtime = executionRuntimes[runtimeId];
  const [command, ...arguments_] = commandParts(commandInput.value.trim());
  if (command === undefined) throw new Error('Enter a command.');
  runtimeOutput.textContent = '';
  runtimeCancellation = createCancellationSource();
  setActivityStatus('working', `Running ${runtime.kind}`);
  runCommandButton.disabled = true;
  thinkingLevelSelect.disabled = true;
  availableModelsSelect.disabled = true;
  cancelRunButton.disabled = false;
  allowReadInput.disabled = true;
  allowWriteInput.disabled = true;
  try {
    const result = await executeBrowserWorkspace(
      runtime,
      createBrowserExecutionWorkspace(workspace, { writeBack: canWriteWorkspace() }),
      { command, arguments: arguments_, timeoutMs: 60_000 },
      {
        signal: runtimeCancellation.signal,
        onOutput: ({ chunk }) => appendRuntimeOutput(chunk),
      },
    );
    appendRuntimeOutput(`\nProcess exited with code ${String(result.exitCode)}.\n`);
    await persistOpfsWorkspace();
    await renderFiles();
    setActivityStatus('idle', 'Ready');
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
    setActivityStatus('error', 'Connection failed');
  });
});

logoutButton.addEventListener('click', () => {
  logoutButton.disabled = true;
  setActivityStatus('working', 'Signing out');
  void authProvider()
    .logout()
    .then(async () => {
      cachedDirectCredentials = undefined;
      await disposeCodingSession();
      return refreshAuthenticationStatus();
    })
    .catch((error: unknown) => {
      setStatus(`Logout failed: ${errorMessage(error)}`);
      setActivityStatus('error', 'Logout failed');
    });
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
  conversations = Object.freeze([]);
  activeConversation = undefined;
  renderConversationHistory();
  renderConversationList();
  void disposeCodingSession()
    .then(() => renderFiles())
    .then(updateControls);
});
const applyAccessPolicy = (): void => {
  if (!allowReadInput.checked) allowWriteInput.checked = false;
  selectedFile = undefined;
  if (activeWorkspaceMode === 'direct') {
    activeWorkspace = undefined;
    activeWorkspaceMode = undefined;
    conversations = Object.freeze([]);
    activeConversation = undefined;
    renderConversationHistory();
    renderConversationList();
    setStatus('Workspace access changed. Reopen the local folder to apply it.');
  } else {
    setStatus(
      `Workspace policy: ${canWriteWorkspace() ? 'read and write' : canReadWorkspace() ? 'read-only' : 'disabled'}.`,
    );
  }
  void disposeCodingSession()
    .then(async () => {
      if (activeWorkspace !== undefined && canReadWorkspace()) {
        await loadConversationState(activeWorkspace);
      } else if (!canReadWorkspace()) {
        conversations = Object.freeze([]);
        activeConversation = undefined;
        renderConversationHistory();
        renderConversationList();
      }
      await renderFiles();
    })
    .then(updateControls);
};
allowReadInput.addEventListener('change', applyAccessPolicy);
allowWriteInput.addEventListener('change', applyAccessPolicy);
newConversationButton.addEventListener('click', () => {
  void createNewConversation().catch((error: unknown) => {
    setStatus(`Conversation failed: ${errorMessage(error)}`);
  });
});
deleteConversationButton.addEventListener('click', () => {
  void deleteActiveConversation().catch((error: unknown) => {
    setStatus(`Conversation deletion failed: ${errorMessage(error)}`);
  });
});
cleanLoomButton.addEventListener('click', () => {
  void cleanWorkspaceLoomDirectory().catch((error: unknown) => {
    setStatus(`.loom cleanup failed: ${errorMessage(error)}`);
  });
});
importFolderButton.addEventListener('click', () => folderInput.click());
importZipButton.addEventListener('click', () => zipInput.click());
folderInput.addEventListener('change', () => {
  void (async () => {
    if (!canWriteWorkspace()) throw new Error('Enable workspace write access before importing.');
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
    if (!canWriteWorkspace()) throw new Error('Enable workspace write access before importing.');
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
    if (!canReadWorkspace()) throw new Error('Enable workspace read access before exporting.');
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
    if (!canWriteWorkspace()) throw new Error('Enable workspace write access before saving.');
    if (activeWorkspace === undefined || selectedFile === undefined) return;
    await activeWorkspace.writeFile(selectedFile, editor.value);
    await persistOpfsWorkspace();
    setStatus(`${selectedFile} saved.`);
  })().catch((error: unknown) => setStatus(`Save failed: ${errorMessage(error)}`));
});
runCommandButton.addEventListener('click', () => {
  void runCommand().catch((error: unknown) => {
    appendRuntimeOutput(`Error: ${errorMessage(error)}\n`);
    setActivityStatus('error', 'Command failed');
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
refreshModelsButton.addEventListener('click', () => {
  void refreshModels();
});
thinkingLevelSelect.addEventListener('change', () => {
  globalThis.localStorage.setItem('loom.thinking-level', thinkingLevelSelect.value);
  void disposeCodingSession();
});
availableModelsSelect.addEventListener('change', () => {
  if (availableModelsSelect.value === '') return;
  modelInput.value = availableModelsSelect.value;
  modelInput.dispatchEvent(new Event('change'));
});
modelInput.addEventListener('change', () => {
  if (selectedModelProvider() === 'openai-compatible-responses') {
    try {
      saveLocalModelConnection(globalThis.localStorage, {
        baseUrl: localModelBaseUrlInput.value,
        model: modelInput.value,
        apiKey: localModelApiKeyInput.value,
      });
    } catch {
      // Base URL validation and its actionable error are presented by the explicit Connect action.
    }
  } else {
    codexModelSelection = modelInput.value;
  }
  updateControls();
  void disposeCodingSession();
});
modelProviderSelect.addEventListener('change', () => {
  renderDiscoveredModels([]);
  const provider = selectedModelProvider();
  if (provider === 'openai-compatible-responses') {
    codexModelSelection = modelInput.value;
    const settings = loadLocalModelConnection(globalThis.localStorage);
    modelInput.value = settings.model;
    localModelBaseUrlInput.value = settings.baseUrl;
    localModelApiKeyInput.value = settings.apiKey;
    setStatus('Click Connect before sending a request to this model server.');
  } else {
    modelInput.value = codexModelSelection;
    setStatus(
      authenticated
        ? 'Authenticated. Open a workspace or run the agent to choose one.'
        : 'Not authenticated. Complete sign-in from the extension options page.',
    );
  }
  saveWorkbenchProvider(globalThis.localStorage, provider);
  updateModelProviderView();
  void disposeCodingSession();
});
connectLocalModelButton.addEventListener('click', () => {
  void discoverLocalModels().catch((error: unknown) => {
    localModelConnected = false;
    updateControls();
    localModelConnectionStatus.textContent = errorMessage(error);
    setStatus(`Model connection failed: ${errorMessage(error)}`);
    setActivityStatus('error', 'Connection failed');
  });
});
clearLocalModelKeyButton.addEventListener('click', () => {
  localModelApiKeyInput.value = '';
  clearLocalModelApiKey(globalThis.localStorage);
  localModelConnected = false;
  localModelConnectionStatus.textContent = 'API key cleared. Connect again to apply the change.';
  setStatus('Local model API key cleared from browser storage.');
  updateControls();
  void disposeCodingSession();
});
for (const input of [localModelBaseUrlInput, localModelApiKeyInput]) {
  input.addEventListener('input', () => {
    localModelConnected = false;
    localModelConnectionStatus.textContent = 'Connection settings changed. Connect again.';
    updateControls();
    void disposeCodingSession();
  });
}
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
      setActivityStatus('error', 'Connection failed');
    });
  }
});

setTransportMode(storedTransportMode());
setActivityStatus('idle', 'Ready');
updateModelProviderView();
updateControls();
if (
  selectedModelProvider() === 'codex-experimental' &&
  EXTENSION_ID_PATTERN.test(extensionIdInput.value.trim())
) {
  setStatus('Connecting to extension…');
  void refreshAuthenticationStatus().catch((error: unknown) => {
    authenticated = false;
    updateControls();
    setStatus(`Connection failed: ${errorMessage(error)}`);
    setActivityStatus('error', 'Connection failed');
  });
} else if (selectedModelProvider() === 'openai-compatible-responses') {
  setStatus('Click Connect before sending a request to this model server.');
  setActivityStatus('error', 'Connect server');
}
