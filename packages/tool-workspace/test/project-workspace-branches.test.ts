import type { PluginInitializeContext } from '@loom/plugin-api';
import { createCancellationSource, systemClock } from '@loom/types';
import { describe, expect, it } from 'vitest';

import {
  APPLY_PATCH_TOOL_KEY,
  CREATE_DIRECTORY_TOOL_KEY,
  LIST_FILES_TOOL_KEY,
  MOVE_TOOL_KEY,
  PROJECT_WORKSPACE_TOOLS_PLUGIN_ID,
  READ_BYTES_TOOL_KEY,
  READ_FILE_TOOL_KEY,
  REMOVE_TOOL_KEY,
  STAT_TOOL_KEY,
  WRITE_BYTES_TOOL_KEY,
  WRITE_FILE_TOOL_KEY,
  applyStrictUnifiedPatch,
  createMemoryProjectWorkspace,
  createProjectWorkspaceTools,
  createProjectWorkspaceToolsPlugin,
  decodeWorkspaceZip,
  encodeWorkspaceZip,
  importBrowserFolderFiles,
  isProjectWorkspace,
  validateWorkspaceImportEntries,
  workspacePath,
  type WorkspaceTool,
} from '../src/index.js';

function zipView(zip: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly end: number;
  readonly central: number;
} {
  const bytes = Uint8Array.from(zip);
  const view = new DataView(bytes.buffer);
  const end = bytes.byteLength - 22;
  return { bytes, view, end, central: view.getUint32(end + 16, true) };
}

function oneFileZip(): Uint8Array {
  return encodeWorkspaceZip([
    { path: 'a.txt', kind: 'file', content: new TextEncoder().encode('x') },
  ]);
}

describe('project workspace contract and tool branches', () => {
  it('detects complete project workspaces and rejects incomplete text adapters', () => {
    expect(isProjectWorkspace(createMemoryProjectWorkspace())).toBe(true);
    expect(
      isProjectWorkspace({
        listFiles: async () => [],
        readFile: async () => '',
        writeFile: async () => true,
      }),
    ).toBe(false);
  });

  it('registers all legacy and project tools under stable keys', async () => {
    const registrations: { key: unknown; value: unknown }[] = [];
    const plugin = createProjectWorkspaceToolsPlugin(createMemoryProjectWorkspace());
    await plugin.initialize?.({
      pluginId: PROJECT_WORKSPACE_TOOLS_PLUGIN_ID,
      configuration: Object.freeze({}),
      clock: systemClock,
      events: { on: () => () => undefined, emit: async () => undefined },
      capabilities: {
        register: (key: unknown, value: unknown) => registrations.push({ key, value }),
      },
      services: {},
    } as unknown as PluginInitializeContext);

    expect(registrations.map(({ key }) => key)).toEqual([
      LIST_FILES_TOOL_KEY,
      READ_FILE_TOOL_KEY,
      WRITE_FILE_TOOL_KEY,
      STAT_TOOL_KEY,
      READ_BYTES_TOOL_KEY,
      WRITE_BYTES_TOOL_KEY,
      CREATE_DIRECTORY_TOOL_KEY,
      MOVE_TOOL_KEY,
      REMOVE_TOOL_KEY,
      APPLY_PATCH_TOOL_KEY,
    ]);
    expect(registrations.map(({ value }) => (value as WorkspaceTool).operation)).toHaveLength(10);
  });

  it('validates every project tool input and optional boolean', async () => {
    const tools = createProjectWorkspaceTools(createMemoryProjectWorkspace());
    await expect(tools.stat.execute(null as never)).rejects.toThrow('must be an object');
    await expect(tools.stat.execute([] as never)).rejects.toThrow('must be an object');
    await expect(tools.stat.execute(Object.create({ path: 'x' }) as never)).rejects.toThrow(
      'plain object',
    );
    await expect(tools.stat.execute({ path: 1 } as never)).rejects.toThrow('string path');
    await expect(tools.stat.execute({ path: 'x', extra: true } as never)).rejects.toThrow(
      'unknown property',
    );
    await expect(
      tools.writeBytes.execute({ path: workspacePath('x'), content: 'text' } as never),
    ).rejects.toThrow('Uint8Array');
    await expect(
      tools.createDirectory.execute({ path: workspacePath('x'), recursive: 'yes' } as never),
    ).rejects.toThrow('boolean');
    await expect(
      tools.move.execute({ source: workspacePath('x'), destination: 1 } as never),
    ).rejects.toThrow('string path');
    await expect(
      tools.remove.execute({ path: workspacePath('x'), recursive: 1 } as never),
    ).rejects.toThrow('boolean');
  });

  it('honors cancellation before project tool adapter calls', async () => {
    const tools = createProjectWorkspaceTools(createMemoryProjectWorkspace());
    const cancellation = createCancellationSource();
    cancellation.cancel('stop');
    await expect(
      tools.createDirectory.execute(
        { path: workspacePath('cancelled') },
        { signal: cancellation.signal },
      ),
    ).rejects.toThrow('Operation cancelled');
  });
});

describe('memory workspace failure branches', () => {
  it('rejects duplicate, missing-parent, and wrong-kind initial entries', () => {
    expect(() =>
      createMemoryProjectWorkspace({
        entries: [
          { path: workspacePath('same'), kind: 'directory' },
          { path: workspacePath('same'), kind: 'directory' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ENTRY_EXISTS' }));
    expect(() =>
      createMemoryProjectWorkspace({
        entries: [{ path: workspacePath('missing/file'), kind: 'file', content: '' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ENTRY_NOT_FOUND' }));
    expect(() =>
      createMemoryProjectWorkspace({
        entries: [
          { path: workspacePath('file'), kind: 'file', content: '' },
          { path: workspacePath('file/child'), kind: 'file', content: '' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXPECTED_DIRECTORY' }));
  });

  it('rejects missing and wrong-kind reads, writes, lists, and directories', async () => {
    const workspace = createMemoryProjectWorkspace({
      entries: [
        { path: workspacePath('dir'), kind: 'directory' },
        { path: workspacePath('file'), kind: 'file', content: 'x' },
      ],
    });
    await expect(workspace.stat(workspacePath('missing'))).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    await expect(workspace.readBytes(workspacePath('dir'))).rejects.toMatchObject({
      code: 'EXPECTED_FILE',
    });
    await expect(workspace.listFiles(workspacePath('file'))).rejects.toMatchObject({
      code: 'EXPECTED_DIRECTORY',
    });
    await expect(workspace.writeFile(workspacePath('dir'), 'x')).rejects.toMatchObject({
      code: 'EXPECTED_FILE',
    });
    await expect(workspace.createDirectory(workspacePath('file'))).rejects.toMatchObject({
      code: 'EXPECTED_DIRECTORY',
    });
    await expect(workspace.createDirectory(workspacePath('missing/child'))).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    expect(await workspace.createDirectory(workspacePath('dir'))).toBe(false);
  });

  it('validates move conflicts, ancestry, overwrite, and no-op behavior', async () => {
    const workspace = createMemoryProjectWorkspace({
      entries: [
        { path: workspacePath('src'), kind: 'directory' },
        { path: workspacePath('src/file'), kind: 'file', content: 'source' },
        { path: workspacePath('dest'), kind: 'directory' },
        { path: workspacePath('dest/old'), kind: 'file', content: 'old' },
      ],
    });
    await workspace.move(workspacePath('src'), workspacePath('src'));
    await expect(
      workspace.move(workspacePath('src'), workspacePath('src/nested')),
    ).rejects.toMatchObject({ code: 'INVALID_MOVE' });
    await expect(
      workspace.move(workspacePath('src/file'), workspacePath('src')),
    ).rejects.toMatchObject({ code: 'INVALID_MOVE' });
    await expect(workspace.move(workspacePath('src'), workspacePath('dest'))).rejects.toMatchObject(
      {
        code: 'ENTRY_EXISTS',
      },
    );
    await workspace.move(workspacePath('src'), workspacePath('dest'), { overwrite: true });
    expect(await workspace.readFile(workspacePath('dest/file'))).toBe('source');
  });
});

describe('archive validation and corrupt ZIP branches', () => {
  it('enforces entry, path, file, and total import limits', () => {
    expect(() =>
      validateWorkspaceImportEntries(
        [
          { path: 'a', kind: 'directory' },
          { path: 'b', kind: 'directory' },
        ],
        { maxEntries: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() =>
      validateWorkspaceImportEntries([{ path: 'long', kind: 'directory' }], { maxPathLength: 3 }),
    ).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() =>
      validateWorkspaceImportEntries(
        [{ path: 'large', kind: 'file', content: new Uint8Array(2) }],
        { maxFileBytes: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() =>
      validateWorkspaceImportEntries(
        [
          { path: 'a', kind: 'file', content: new Uint8Array(1) },
          { path: 'b', kind: 'file', content: new Uint8Array(1) },
        ],
        { maxTotalBytes: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() =>
      validateWorkspaceImportEntries([
        { path: 'bad', kind: 'file', content: 'bad' as unknown as Uint8Array },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }));
  });

  it('handles empty and unrooted browser folder selections', async () => {
    const empty = createMemoryProjectWorkspace();
    await expect(importBrowserFolderFiles(empty, [])).resolves.toEqual([]);
    const workspace = createMemoryProjectWorkspace();
    await importBrowserFolderFiles(
      workspace,
      [{ name: 'loose.txt', arrayBuffer: async () => new TextEncoder().encode('x').buffer }],
      { stripCommonRoot: false },
    );
    expect(await workspace.readFile(workspacePath('loose.txt'))).toBe('x');
  });

  it('rejects missing, multi-disk, ZIP64, oversized, and malformed central directories', async () => {
    await expect(decodeWorkspaceZip(new Uint8Array())).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });

    const multi = zipView(oneFileZip());
    multi.view.setUint16(multi.end + 4, 1, true);
    await expect(decodeWorkspaceZip(multi.bytes)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ZIP',
    });

    const zip64 = zipView(oneFileZip());
    zip64.view.setUint16(zip64.end + 10, 0xffff, true);
    await expect(decodeWorkspaceZip(zip64.bytes)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ZIP',
    });

    const tooMany = zipView(oneFileZip());
    tooMany.view.setUint16(tooMany.end + 10, 2, true);
    await expect(decodeWorkspaceZip(tooMany.bytes, { maxEntries: 1 })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });

    const bounds = zipView(oneFileZip());
    bounds.view.setUint32(bounds.end + 12, bounds.end + 1, true);
    await expect(decodeWorkspaceZip(bounds.bytes)).rejects.toMatchObject({ code: 'INVALID_ZIP' });

    const signature = zipView(oneFileZip());
    signature.view.setUint32(signature.central, 0, true);
    await expect(decodeWorkspaceZip(signature.bytes)).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
  });

  it('rejects encryption, symlinks, invalid names, unsupported compression, and corruption', async () => {
    const encrypted = zipView(oneFileZip());
    encrypted.view.setUint16(encrypted.central + 8, 1, true);
    await expect(decodeWorkspaceZip(encrypted.bytes)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ZIP',
    });

    const symlink = zipView(oneFileZip());
    symlink.view.setUint32(symlink.central + 38, 0xa0000000, true);
    await expect(decodeWorkspaceZip(symlink.bytes)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ZIP',
    });

    const invalidName = zipView(oneFileZip());
    invalidName.bytes[invalidName.central + 46] = 0xff;
    await expect(decodeWorkspaceZip(invalidName.bytes)).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });

    const compression = zipView(oneFileZip());
    compression.view.setUint16(compression.central + 10, 99, true);
    await expect(decodeWorkspaceZip(compression.bytes)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ZIP',
    });

    const local = zipView(oneFileZip());
    local.view.setUint32(0, 0, true);
    await expect(decodeWorkspaceZip(local.bytes)).rejects.toMatchObject({ code: 'INVALID_ZIP' });

    const checksum = zipView(oneFileZip());
    checksum.bytes[35] = 2;
    await expect(decodeWorkspaceZip(checksum.bytes)).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
  });

  it('rejects archive expansion and compression-ratio declarations before extraction', async () => {
    const size = zipView(oneFileZip());
    size.view.setUint32(size.central + 24, 2, true);
    await expect(decodeWorkspaceZip(size.bytes, { maxFileBytes: 1 })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });

    const ratio = zipView(oneFileZip());
    ratio.view.setUint32(ratio.central + 24, 101, true);
    await expect(
      decodeWorkspaceZip(ratio.bytes, { maxFileBytes: 200, maxTotalBytes: 200 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('strict patch parser branches', () => {
  it.each([
    '',
    '\0',
    '--- a/file\nnot-a-plus-header',
    'unexpected',
    '@@ invalid @@\n line',
    '@@ -1 +1 @@\n\\ No newline at end of file',
    '@@ -1 +1 @@\n?bad',
    '@@ -1,2 +1 @@\n line',
  ])('rejects malformed unified diff %j', (patch) => {
    expect(() => applyStrictUnifiedPatch('line\n', patch)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('accepts git metadata and CRLF patches while enforcing file bounds and newline markers', () => {
    expect(
      applyStrictUnifiedPatch(
        'line\n',
        'diff --git a/f b/f\r\nindex 1..2\r\n--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-line\r\n+next\r\n',
      ).content,
    ).toBe('next\n');
    expect(() => applyStrictUnifiedPatch('', '@@ -2,0 +2,0 @@\n')).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_MISMATCH' }),
    );
    expect(() =>
      applyStrictUnifiedPatch('a\nb\n', '@@ -1 +1 @@\n a\n\\ No newline at end of file\n'),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PATCH' }));
  });
});
