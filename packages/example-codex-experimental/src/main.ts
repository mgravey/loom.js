import type { CodexAgentEvent, CodexAgentTool } from '@mgravey/loom-agent-codex';
import { createCodingSession, type CodingSession } from '@mgravey/loom-coding';
import {
  createPyodideExecutionRuntime,
  createQuickJsExecutionRuntime,
  createWebContainerExecutionRuntime,
  executeBrowserWorkspace,
  type BrowserExecutionRuntime,
} from '@mgravey/loom-execution-browser';
import type { CodexReasoningEffort } from '@mgravey/loom-model-codex-experimental';
import {
  OpenAIResponsesModelError,
  createOpenAICompatibleResponsesModel,
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
import { ChatGPTDirectError, createChatGPTDirectClient } from './chatgpt-direct.js';
import {
  cleanLoomDirectory,
  createWorkspaceConversation,
  loadWorkspaceConversations,
  removeWorkspaceConversation,
  saveWorkspaceConversation,
  updateWorkspaceConversation,
  type WorkspaceConversation,
} from './conversation-store.js';
const DEFAULT_RUN_SESSION_ID = sessionId('codex-experimental-browser-run');
const OPFS_DIRECTORY = 'loom-workbench';
const OPFS_ARCHIVE = 'project.zip';
interface DirectoryPickerHost {
  showDirectoryPicker(options?: {
    readonly mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

function requiredElement<ElementType extends HTMLElement>(
  selector: string,
  constructor: new () => ElementType,
): ElementType {
  const element = globalThis.document.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing required element ${selector}.`);
  return element;
}

const chatgptClient = createChatGPTDirectClient();
const chatgptAccountSelect = requiredElement('#chatgpt-account', HTMLSelectElement);
const chatgptSignInButton = requiredElement('#chatgpt-sign-in', HTMLButtonElement);
const chatgptCancelSignInButton = requiredElement('#chatgpt-cancel-sign-in', HTMLButtonElement);
const chatgptSignOutButton = requiredElement('#chatgpt-sign-out', HTMLButtonElement);
const chatgptStatus = requiredElement('#chatgpt-status', HTMLParagraphElement);
const chatgptError = requiredElement('#chatgpt-error', HTMLParagraphElement);
const chatgptLocalOnly = requiredElement('#chatgpt-local-only', HTMLParagraphElement);
const chatgptPlanConfirmation = requiredElement('#chatgpt-plan-confirmation', HTMLDivElement);
const chatgptDismissConfirmation = requiredElement(
  '#chatgpt-dismiss-confirmation',
  HTMLButtonElement,
);
let chatgptAuthTransition = false;
let chatgptAuthRevision = 0;
let agentRunActive = false;
let modelsLoading = false;
const confirmedRegistrations = new Set<string>();

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
const promptInput = requiredElement('#prompt', HTMLTextAreaElement);
const runButton = requiredElement('#run', HTMLButtonElement);
const cancelRunButton = requiredElement('#cancel-run', HTMLButtonElement);
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

// Connection mode is always browser ChatGPT, regardless of legacy URL or storage settings.
// Remove the old page-held server secret without reading or migrating it.
try {
  globalThis.localStorage.removeItem('loom.local-model.api-key');
} catch {
  // Storage can be unavailable; the workbench never uses legacy credentials.
}
modelInput.value = '';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setStatus(message: string): void {
  statusElement.textContent = message;
  statusElement.hidden = message === '';
}

function setChatGPTError(message = ''): void {
  chatgptError.textContent = message;
  chatgptError.hidden = message === '';
  chatgptStatus.hidden = message !== '';
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
  if (error instanceof ChatGPTDirectError) return error.message;
  if (error instanceof OpenAIResponsesModelError) {
    return error.code === 'AUTHENTICATION_FAILED' || error.status === 401 || error.status === 403
      ? 'ChatGPT access is unavailable. Continue with ChatGPT again to check your plan access.'
      : 'The browser could not complete the ChatGPT request. This local compatibility test may be blocked by the provider. Try signing in again or retry later.';
  }
  return error instanceof Error ? error.message : String(error);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function directoryPicker(): DirectoryPickerHost['showDirectoryPicker'] {
  const picker = (globalThis as typeof globalThis & Partial<DirectoryPickerHost>)
    .showDirectoryPicker;
  if (typeof picker !== 'function')
    throw new Error('This browser does not support directory selection.');
  return picker.bind(globalThis);
}

interface SelectableModel {
  readonly id: string;
  readonly model: string;
  readonly label: string;
}
let availableModels: readonly SelectableModel[] = [];
let catalogueRevision = 0;
function renderDiscoveredModels(models: readonly SelectableModel[]): void {
  availableModels = models;
  availableModelsSelect.replaceChildren(
    new Option('Select a model', ''),
    ...models.map((model) => new Option(model.label, model.id)),
  );
  const selected = models.find((entry) => entry.model === modelInput.value);
  availableModelsSelect.value = selected?.id ?? '';
}

async function refreshModels(quiet = false): Promise<void> {
  const revision = ++catalogueRevision;
  modelsLoading = true;
  updateControls();
  setChatGPTError();
  try {
    const status = chatgptClient.getStatus();
    if (!status.authenticated || !status.planEnabled) {
      renderDiscoveredModels([]);
      return;
    }
    const models = await chatgptClient.listModels();
    if (revision !== catalogueRevision) return;
    if (!models.some((model) => model.slug === modelInput.value))
      modelInput.value = models[0]?.slug ?? '';
    renderDiscoveredModels(
      models.map((model) => ({
        id: `chatgpt-direct:${model.slug}`,
        model: model.slug,
        label: `ChatGPT / ${model.displayName}`,
      })),
    );
    if (!quiet)
      setStatus(
        models.length === 0
          ? 'No ChatGPT models are available for this account.'
          : 'ChatGPT models refreshed.',
      );
  } catch (error) {
    if (revision === catalogueRevision) {
      renderDiscoveredModels([]);
      const message = `ChatGPT model discovery failed: ${errorMessage(error)}`;
      setChatGPTError(message);
      setStatus('');
    }
  } finally {
    if (revision === catalogueRevision) {
      modelsLoading = false;
      syncChatGPTStatus();
      updateControls();
    }
  }
}

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

function modelConnectionReady(): boolean {
  const status = chatgptClient.getStatus();
  return (
    status.authenticated &&
    status.planEnabled &&
    chatgptAccountSelect.value === status.activeAccountId &&
    availableModels.some((model) => model.model === modelInput.value)
  );
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
  const busy =
    agentRunActive ||
    codingSession?.state === 'running' ||
    runtimeCancellation !== undefined ||
    chatgptAuthTransition;
  const directStatus = chatgptClient.getStatus();
  modelInput.disabled = busy;
  refreshModelsButton.disabled =
    busy || modelsLoading || !directStatus.authenticated || !directStatus.planEnabled;
  chatgptAccountSelect.disabled = busy;
  chatgptSignInButton.disabled = busy || !directStatus.supported;
  chatgptSignOutButton.disabled = busy;
  chatgptSignOutButton.hidden = !directStatus.authenticated;
  chatgptCancelSignInButton.hidden = !chatgptAuthTransition;
  workspaceMode.disabled = busy;
  runtimeSelect.disabled = busy;
  commandInput.disabled = busy;
  thinkingLevelSelect.disabled = busy;
  availableModelsSelect.disabled = busy;
  runButton.disabled = busy || !modelConnectionReady() || !readable;
  openWorkspaceButton.disabled = !readable || busy;
  importFolderButton.disabled = busy || !writable;
  importZipButton.disabled = busy || !writable;
  exportZipButton.disabled = busy || !hasWorkspace || !readable;
  runCommandButton.disabled = busy || !hasWorkspace || !readable;
  editor.disabled = busy || selectedFile === undefined || !readable;
  saveFileButton.disabled = busy || selectedFile === undefined || !writable;
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

function accountDisplayLabel(label: string, index?: number): string {
  const safeLabel = label
    .replace(/\s*\(oaiapp[^)]*\)/giu, '')
    .replace(/oaiapp[^\s)]*/giu, '')
    .replace(/^Unverified ChatGPT registration (\d+)$/u, 'Account $1 · sign-in incomplete')
    .trim();
  return safeLabel || `ChatGPT account${index === undefined ? '' : ` ${String(index + 1)}`}`;
}

function syncChatGPTStatus(): void {
  const status = chatgptClient.getStatus();
  const selectedAccount = chatgptAccountSelect.value;
  chatgptAccountSelect.replaceChildren(
    new Option('Use another account', ''),
    ...status.accounts.map(
      (account, index) => new Option(accountDisplayLabel(account.label, index), account.id),
    ),
  );
  chatgptAccountSelect.value = status.accounts.some((account) => account.id === selectedAccount)
    ? selectedAccount
    : (status.activeAccountId ?? '');
  const accountLabel = chatgptAccountSelect.closest('label');
  if (accountLabel !== null) accountLabel.hidden = status.accounts.length === 0;
  chatgptLocalOnly.hidden = status.supported;
  chatgptStatus.textContent = !status.supported
    ? 'Sign-in is unavailable on this origin.'
    : status.authenticated && status.planEnabled
      ? `Connected${status.accountLabel === undefined ? '' : ` as ${accountDisplayLabel(status.accountLabel)}`}. Your ChatGPT plan is enabled.`
      : status.authenticated
        ? 'Your ChatGPT plan is not enabled for this session. Continue with ChatGPT to complete consent.'
        : 'Use your ChatGPT account and plan.';
  if (
    status.notice !== undefined &&
    status.notice !== '' &&
    status.notice !== 'Local browser sign-in is experimental.'
  ) {
    chatgptStatus.append(` ${status.notice}`);
  }
  if (!status.authenticated || !status.planEnabled) chatgptPlanConfirmation.hidden = true;
  setActivityStatus(
    status.authenticated && status.planEnabled ? 'idle' : 'error',
    status.authenticated && status.planEnabled
      ? 'Ready'
      : status.supported
        ? 'Sign-in required'
        : 'Local test only',
  );
}

function showPlanConfirmation(): void {
  const status = chatgptClient.getStatus();
  if (!status.authenticated || !status.planEnabled || status.activeAccountId === undefined) return;
  // Account IDs identify public registrations; this marker contains no credentials.
  const key = `loom.chatgpt-direct.plan-confirmed.${status.activeAccountId}`;
  if (confirmedRegistrations.has(key)) return;
  try {
    if (globalThis.localStorage.getItem(key) === 'true') return;
    globalThis.localStorage.setItem(key, 'true');
  } catch {
    // Confirmation still works for the lifetime of this page if storage is unavailable.
  }
  confirmedRegistrations.add(key);
  chatgptPlanConfirmation.hidden = false;
}

chatgptSignInButton.addEventListener('click', () => {
  if (chatgptAuthTransition || agentRunActive) return;
  const previousRegistrations = new Set(chatgptClient.getStatus().accounts.map(({ id }) => id));
  setChatGPTError();
  const revision = ++chatgptAuthRevision;
  chatgptAuthTransition = true;
  catalogueRevision += 1;
  modelsLoading = false;
  renderDiscoveredModels([]);
  void disposeCodingSession();
  updateControls();
  chatgptPlanConfirmation.hidden = true;
  setStatus('');
  chatgptStatus.textContent = 'Continue in the ChatGPT sign-in window. Waiting for verification.';
  setActivityStatus('working', 'Signing in');
  // Invoke synchronously in this gesture so the browser permits the sign-in popup.
  let signIn: Promise<void>;
  try {
    signIn = chatgptClient.signIn(chatgptAccountSelect.value || undefined);
  } catch (error) {
    signIn = Promise.reject(error instanceof Error ? error : new Error('ChatGPT sign-in failed.'));
  }
  void (async () => {
    try {
      await signIn;
      if (revision !== chatgptAuthRevision) return;
      syncChatGPTStatus();
      showPlanConfirmation();
      setStatus('');
      await refreshModels(true);
    } catch (error) {
      if (revision !== chatgptAuthRevision) return;
      syncChatGPTStatus();
      const created = chatgptClient
        .getStatus()
        .accounts.find(({ id }) => !previousRegistrations.has(id));
      if (created !== undefined) chatgptAccountSelect.value = created.id;
      const message = `ChatGPT sign-in failed: ${errorMessage(error)}`;
      setChatGPTError(message);
      setStatus('');
      setActivityStatus('error', 'Sign-in failed');
    } finally {
      if (revision === chatgptAuthRevision) {
        chatgptAuthTransition = false;
        updateControls();
      }
    }
  })();
});
chatgptCancelSignInButton.addEventListener('click', () => {
  chatgptAuthRevision += 1;
  catalogueRevision += 1;
  modelsLoading = false;
  chatgptClient.cancelSignIn();
  chatgptAuthTransition = false;
  syncChatGPTStatus();
  updateControls();
  setChatGPTError();
  chatgptStatus.textContent = 'ChatGPT login cancelled.';
});
chatgptAccountSelect.addEventListener('change', () => {
  chatgptClient.cancelSignIn();
  void disposeCodingSession();
  updateControls();
  setChatGPTError();
  chatgptStatus.textContent = 'Continue with ChatGPT to sign in with the selected account.';
});
chatgptSignOutButton.addEventListener('click', () => {
  setChatGPTError();
  chatgptAuthRevision += 1;
  catalogueRevision += 1;
  modelsLoading = false;
  chatgptAuthTransition = true;
  chatgptClient.cancelSignIn();
  void disposeCodingSession();
  renderDiscoveredModels([]);
  chatgptPlanConfirmation.hidden = true;
  updateControls();
  chatgptCancelSignInButton.hidden = true;
  chatgptStatus.textContent = 'Signing out…';
  let signOutNotice = '';
  void chatgptClient
    .signOut()
    .then(({ revoked }) => {
      signOutNotice = revoked
        ? 'Signed out of ChatGPT.'
        : 'Signed out of this tab. Provider revocation could not be confirmed.';
    })
    .catch((error: unknown) => {
      setChatGPTError(`ChatGPT sign-out failed: ${errorMessage(error)}`);
    })
    .finally(() => {
      chatgptAuthTransition = false;
      syncChatGPTStatus();
      if (signOutNotice !== '') chatgptStatus.textContent = signOutNotice;
      updateControls();
    });
});
chatgptDismissConfirmation.addEventListener('click', () => {
  chatgptPlanConfirmation.hidden = true;
});

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
  const session = codingSession;
  codingSession = undefined;
  session?.cancel(new Error('Model connection changed.'));
  if (session !== undefined) await session.dispose();
}

function renderConversationHistory(): void {
  logElement.replaceChildren();
  activeToolRows.clear();
  activeAssistantMessage = undefined;
  activeAssistantText = '';
  if (activeConversation === undefined) return;
  // Older transcripts remain usable; their server connection and model were discarded on load.
  if (activeConversation.model !== '') modelInput.value = activeConversation.model;
  renderDiscoveredModels(availableModels);
  updateControls();
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
    const drawer = editor.closest('details');
    if (drawer instanceof HTMLDetailsElement) drawer.open = true;
    updateControls();
    editor.focus();
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
  if (!modelConnectionReady())
    throw new Error('Continue with ChatGPT and choose a model before running.');
  const selectedModel = createOpenAICompatibleResponsesModel({
    ...reasoningOptions,
    model,
    transport: chatgptClient.transport,
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
  if (agentRunActive || chatgptAuthTransition || !modelConnectionReady()) return;
  agentRunActive = true;
  updateControls();
  runButton.disabled = true;
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
    agentRunActive = false;
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
  updateControls();
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
  const selected = availableModels.find((entry) => entry.id === availableModelsSelect.value);
  if (selected === undefined) return;
  modelInput.value = selected.model;
  renderDiscoveredModels(availableModels);
  modelInput.dispatchEvent(new Event('change'));
});
modelInput.addEventListener('change', () => {
  renderDiscoveredModels(availableModels);
  updateControls();
  void disposeCodingSession();
});

transportStatusElement.textContent = 'ChatGPT';
transportStatusElement.dataset.mode = 'direct';
setStatus('');
syncChatGPTStatus();
updateControls();

globalThis.addEventListener('pagehide', () => {
  chatgptClient.dispose();
});
