import { createMemoryProjectWorkspace, workspacePath } from '@mgravey/loom-tool-workspace';
import { describe, expect, it } from 'vitest';

import {
  cleanLoomDirectory,
  conversationTitle,
  createWorkspaceConversation,
  loadWorkspaceConversations,
  removeWorkspaceConversation,
  saveWorkspaceConversation,
  updateWorkspaceConversation,
} from '../src/conversation-store.js';

describe('workspace conversation storage', () => {
  it('saves, lists, updates, and removes multiple conversations under .loom', async () => {
    const workspace = createMemoryProjectWorkspace();
    const first = createWorkspaceConversation({
      model: 'model-a',
      now: () => 10,
      randomId: () => 'first',
    });
    const second = createWorkspaceConversation({
      model: 'model-b',
      now: () => 20,
      randomId: () => 'second',
    });
    await saveWorkspaceConversation(
      workspace,
      updateWorkspaceConversation(
        first,
        [
          { role: 'user', content: 'Build the parser' },
          { role: 'assistant', content: 'Done.' },
        ],
        'model-a',
        30,
      ),
    );
    await saveWorkspaceConversation(workspace, second);

    await expect(loadWorkspaceConversations(workspace)).resolves.toMatchObject([
      { id: 'conversation-first', title: 'Build the parser', updatedAt: 30 },
      { id: 'conversation-second', title: 'New conversation', updatedAt: 20 },
    ]);

    await removeWorkspaceConversation(workspace, 'conversation-first');
    await expect(loadWorkspaceConversations(workspace)).resolves.toMatchObject([
      { id: 'conversation-second' },
    ]);
  });

  it('ignores corrupt records and cleans all Loom-owned workspace state', async () => {
    const workspace = createMemoryProjectWorkspace();
    await workspace.createDirectory(workspacePath('.loom'), { recursive: true });
    await workspace.createDirectory(workspacePath('.loom/conversations'), { recursive: true });
    await workspace.writeFile(workspacePath('.loom/conversations/conversation-broken.json'), '{');
    await workspace.createDirectory(workspacePath('.loom/figures'), { recursive: true });
    await workspace.writeFile(workspacePath('.loom/figures/chart.png'), 'image');

    await expect(loadWorkspaceConversations(workspace)).resolves.toEqual([]);
    await cleanLoomDirectory(workspace);
    await expect(workspace.listFiles(undefined)).resolves.toEqual([]);
  });

  it('creates bounded readable titles', () => {
    expect(conversationTitle('  Run\n the   tests  ')).toBe('Run the tests');
    expect(conversationTitle('x'.repeat(80))).toBe(`${'x'.repeat(55)}…`);
  });
});
