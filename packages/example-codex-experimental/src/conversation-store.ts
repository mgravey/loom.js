import type { CodingTranscriptEntry } from '@mgravey/loom-coding';
import {
  workspacePath,
  type ProjectWorkspace,
  type WorkspacePath,
} from '@mgravey/loom-tool-workspace';

export const LOOM_DIRECTORY = workspacePath('.loom');
export const CONVERSATION_DIRECTORY = workspacePath('.loom/conversations');
const CONVERSATION_VERSION = 1;
const CONVERSATION_ID = /^conversation-[a-z0-9-]+$/u;
const MAX_CONVERSATIONS = 500;
const MAX_TRANSCRIPT_ENTRIES = 2_000;
const MAX_TRANSCRIPT_CHARACTERS = 4 * 1024 * 1024;

export interface WorkspaceConversation {
  readonly version: typeof CONVERSATION_VERSION;
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly transcript: readonly CodingTranscriptEntry[];
}

export interface CreateWorkspaceConversationOptions {
  readonly model: string;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingEntry(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === 'NotFoundError' || error.code === 'ENTRY_NOT_FOUND';
}

function conversationPath(id: string): WorkspacePath {
  if (!CONVERSATION_ID.test(id)) throw new TypeError('Conversation ID is invalid.');
  return workspacePath(`${CONVERSATION_DIRECTORY}/${id}.json`);
}

function transcript(value: unknown): readonly CodingTranscriptEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_ENTRIES) return undefined;
  const result: CodingTranscriptEntry[] = [];
  let characters = 0;
  for (const entry of value as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      typeof entry.content !== 'string'
    ) {
      return undefined;
    }
    characters += entry.content.length;
    if (characters > MAX_TRANSCRIPT_CHARACTERS) return undefined;
    result.push(Object.freeze({ role: entry.role, content: entry.content }));
  }
  return Object.freeze(result);
}

function parsedConversation(value: unknown, expectedId: string): WorkspaceConversation | undefined {
  if (!isRecord(value)) return undefined;
  const entries = transcript(value.transcript);
  if (
    value.version !== CONVERSATION_VERSION ||
    value.id !== expectedId ||
    !CONVERSATION_ID.test(expectedId) ||
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    value.title.length > 120 ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    value.model.length > 200 ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    entries === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    version: CONVERSATION_VERSION,
    id: expectedId,
    title: value.title,
    model: value.model,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    transcript: entries,
  });
}

export function conversationTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return 'New conversation';
  return normalized.length <= 56 ? normalized : `${normalized.slice(0, 55).trimEnd()}…`;
}

export function createWorkspaceConversation(
  options: CreateWorkspaceConversationOptions,
): WorkspaceConversation {
  const now = (options.now ?? Date.now)();
  const randomId = (options.randomId ?? (() => globalThis.crypto.randomUUID()))()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '');
  if (randomId.length === 0) throw new TypeError('Conversation random ID is invalid.');
  return Object.freeze({
    version: CONVERSATION_VERSION,
    id: `conversation-${randomId}`,
    title: 'New conversation',
    model: options.model,
    createdAt: now,
    updatedAt: now,
    transcript: Object.freeze([]),
  });
}

export function updateWorkspaceConversation(
  conversation: WorkspaceConversation,
  transcriptEntries: readonly CodingTranscriptEntry[],
  model: string,
  now = Date.now(),
): WorkspaceConversation {
  const entries = transcript(transcriptEntries);
  if (entries === undefined)
    throw new TypeError('Conversation transcript is invalid or too large.');
  const firstPrompt = entries.find((entry) => entry.role === 'user')?.content ?? '';
  return Object.freeze({
    ...conversation,
    title:
      conversation.title === 'New conversation'
        ? conversationTitle(firstPrompt)
        : conversation.title,
    model,
    updatedAt: now,
    transcript: entries,
  });
}

export async function loadWorkspaceConversations(
  workspace: ProjectWorkspace,
): Promise<readonly WorkspaceConversation[]> {
  let entries;
  try {
    entries = await workspace.listFiles(CONVERSATION_DIRECTORY);
  } catch (error) {
    if (missingEntry(error)) return Object.freeze([]);
    throw error;
  }
  const conversations: WorkspaceConversation[] = [];
  for (const entry of entries.slice(0, MAX_CONVERSATIONS)) {
    if (entry.kind !== 'file' || !entry.path.endsWith('.json')) continue;
    const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1, -'.json'.length);
    if (!CONVERSATION_ID.test(filename)) continue;
    try {
      const value: unknown = JSON.parse(await workspace.readFile(entry.path));
      const conversation = parsedConversation(value, filename);
      if (conversation !== undefined) conversations.push(conversation);
    } catch {
      // One corrupt conversation must not prevent the remaining history from loading.
    }
  }
  conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  return Object.freeze(conversations);
}

export async function saveWorkspaceConversation(
  workspace: ProjectWorkspace,
  conversation: WorkspaceConversation,
): Promise<void> {
  const validated = parsedConversation(conversation, conversation.id);
  if (validated === undefined) throw new TypeError('Conversation is invalid.');
  await workspace.createDirectory(LOOM_DIRECTORY, { recursive: true });
  await workspace.createDirectory(CONVERSATION_DIRECTORY, { recursive: true });
  await workspace.writeFile(
    conversationPath(validated.id),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

export async function removeWorkspaceConversation(
  workspace: ProjectWorkspace,
  id: string,
): Promise<void> {
  try {
    await workspace.remove(conversationPath(id));
  } catch (error) {
    if (!missingEntry(error)) throw error;
  }
}

export async function cleanLoomDirectory(workspace: ProjectWorkspace): Promise<void> {
  try {
    await workspace.remove(LOOM_DIRECTORY, { recursive: true });
  } catch (error) {
    if (!missingEntry(error)) throw error;
  }
}
