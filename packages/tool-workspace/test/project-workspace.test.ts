import { describe, expect, it } from 'vitest';

import {
  StrictPatchError,
  WorkspaceArchiveError,
  applyStrictUnifiedPatch,
  createMemoryProjectWorkspace,
  createProjectWorkspaceTools,
  createStrictApplyPatchTool,
  decodeWorkspaceZip,
  encodeWorkspaceZip,
  exportWorkspaceZip,
  importBrowserFolderFiles,
  importWorkspaceEntries,
  importWorkspaceZip,
  snapshotWorkspace,
  validateWorkspaceImportEntries,
  workspacePath,
} from '../src/index.js';

describe('memory project workspace', () => {
  it('supports binary-safe file and directory operations', async () => {
    let time = 10;
    const workspace = createMemoryProjectWorkspace({ now: () => time++ });
    await workspace.createDirectory(workspacePath('src/nested'), { recursive: true });
    const input = new Uint8Array([0, 1, 255]);
    expect(await workspace.writeBytes(workspacePath('src/nested/data.bin'), input)).toBe(true);
    input[0] = 9;

    const read = await workspace.readBytes(workspacePath('src/nested/data.bin'));
    expect([...read]).toEqual([0, 1, 255]);
    read[1] = 9;
    expect([...(await workspace.readBytes(workspacePath('src/nested/data.bin')))]).toEqual([
      0, 1, 255,
    ]);
    expect(await workspace.stat(workspacePath('src/nested/data.bin'))).toMatchObject({
      kind: 'file',
      size: 3,
    });

    await workspace.move(workspacePath('src/nested'), workspacePath('src/renamed'));
    expect(await workspace.listFiles(workspacePath('src/renamed'))).toEqual([
      { path: 'src/renamed/data.bin', kind: 'file' },
    ]);
    await expect(workspace.remove(workspacePath('src'))).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_EMPTY',
    });
    await workspace.remove(workspacePath('src'), { recursive: true });
    expect(await workspace.listFiles(undefined)).toEqual([]);
  });

  it('keeps text compatibility and rejects invalid UTF-8 reads', async () => {
    const workspace = createMemoryProjectWorkspace();
    expect(await workspace.writeFile(workspacePath('hello.txt'), 'Grüß Gott')).toBe(true);
    expect(await workspace.readFile(workspacePath('hello.txt'))).toBe('Grüß Gott');
    await workspace.writeBytes(workspacePath('binary'), new Uint8Array([0xff]));
    await expect(workspace.readFile(workspacePath('binary'))).rejects.toThrow('not valid UTF-8');
  });
});

describe('project workspace tools', () => {
  it('adapts every project mutation and binary operation', async () => {
    const workspace = createMemoryProjectWorkspace();
    const tools = createProjectWorkspaceTools(workspace);

    await tools.createDirectory.execute({ path: workspacePath('src'), recursive: true });
    await tools.writeBytes.execute({
      path: workspacePath('src/data.bin'),
      content: new Uint8Array([1, 2, 3]),
    });
    await expect(
      tools.stat.execute({ path: workspacePath('src/data.bin') }),
    ).resolves.toMatchObject({
      entry: { kind: 'file', size: 3 },
    });
    await expect(
      tools.readBytes.execute({ path: workspacePath('src/data.bin') }),
    ).resolves.toMatchObject({ content: new Uint8Array([1, 2, 3]) });

    await workspace.writeFile(workspacePath('src/code.ts'), 'const value = 1;\n');
    await tools.applyPatch.execute({
      path: workspacePath('src/code.ts'),
      patch: '@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n',
    });
    await tools.move.execute({
      source: workspacePath('src/code.ts'),
      destination: workspacePath('src/main.ts'),
    });
    expect(await workspace.readFile(workspacePath('src/main.ts'))).toBe('const value = 2;\n');
    await tools.remove.execute({ path: workspacePath('src'), recursive: true });
    expect(await workspace.listFiles(undefined)).toEqual([]);
  });
});

describe('safe project import and ZIP round trips', () => {
  it.each(['/absolute', '../escape', 'safe/../../escape', 'C:/escape', 'back\\slash', 'nul\0x'])(
    'rejects unsafe import path %j',
    (path) => {
      expect(() =>
        validateWorkspaceImportEntries([{ path, kind: 'file', content: new Uint8Array() }]),
      ).toThrow(WorkspaceArchiveError);
    },
  );

  it('rejects duplicate and file/directory prefix conflicts before writing', () => {
    expect(() =>
      validateWorkspaceImportEntries([
        { path: 'same', kind: 'directory' },
        { path: 'same/', kind: 'directory' },
      ]),
    ).toThrow('duplicate entry');
    expect(() =>
      validateWorkspaceImportEntries([
        { path: 'file', kind: 'file', content: new Uint8Array() },
        { path: 'file/child', kind: 'file', content: new Uint8Array() },
      ]),
    ).toThrow('cannot contain');
  });

  it('round-trips binary files and empty directories through a standards-compatible ZIP', async () => {
    const source = createMemoryProjectWorkspace();
    await source.createDirectory(workspacePath('empty'));
    await source.createDirectory(workspacePath('src'));
    await source.writeFile(workspacePath('src/index.js'), 'console.log("ok");\n');
    await source.writeBytes(workspacePath('asset.bin'), new Uint8Array([0, 255, 3]));

    const zip = await exportWorkspaceZip(source);
    expect(new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(0, true)).toBe(
      0x04034b50,
    );
    const decoded = await decodeWorkspaceZip(zip);
    expect(decoded.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:empty',
      'directory:src',
      'file:asset.bin',
      'file:src/index.js',
    ]);

    const target = createMemoryProjectWorkspace();
    await importWorkspaceZip(target, zip);
    expect(await snapshotWorkspace(target)).toEqual(await snapshotWorkspace(source));
  });

  it('rejects ZIP traversal names and expansion limits', async () => {
    const zip = encodeWorkspaceZip([
      { path: 'evil.txt', kind: 'file', content: new Uint8Array([1]) },
    ]);
    const unsafe = Uint8Array.from(zip);
    const original = new TextEncoder().encode('evil.txt');
    const replacement = new TextEncoder().encode('../x.txt');
    for (let offset = 0; offset <= unsafe.length - original.length; offset += 1) {
      if (original.every((byte, index) => unsafe[offset + index] === byte)) {
        unsafe.set(replacement, offset);
      }
    }
    await expect(decodeWorkspaceZip(unsafe)).rejects.toMatchObject({ code: 'INVALID_ENTRY' });
    await expect(decodeWorkspaceZip(zip, { maxTotalBytes: 1 })).resolves.toBeDefined();
    await expect(decodeWorkspaceZip(zip, { maxTotalBytes: 0 })).rejects.toThrow(TypeError);
  });

  it('imports browser folder uploads without retaining the selected root folder', async () => {
    const workspace = createMemoryProjectWorkspace();
    const files = [
      {
        name: 'a.txt',
        webkitRelativePath: 'project/src/a.txt',
        arrayBuffer: async () => new TextEncoder().encode('a').buffer,
      },
      {
        name: 'b.bin',
        webkitRelativePath: 'project/b.bin',
        arrayBuffer: async () => new Uint8Array([2]).buffer,
      },
    ];
    await importBrowserFolderFiles(workspace, files);
    expect(await workspace.readFile(workspacePath('src/a.txt'))).toBe('a');
    expect([...(await workspace.readBytes(workspacePath('b.bin')))]).toEqual([2]);
  });

  it('preflights conflicts and replaces incompatible entries only when overwrite is enabled', async () => {
    const workspace = createMemoryProjectWorkspace({
      entries: [{ path: workspacePath('target'), kind: 'file', content: 'old' }],
    });
    const entries = [
      { path: 'target', kind: 'directory' as const },
      { path: 'target/new.txt', kind: 'file' as const, content: new TextEncoder().encode('new') },
    ];
    await expect(importWorkspaceEntries(workspace, entries)).rejects.toMatchObject({
      code: 'ENTRY_CONFLICT',
    });
    expect(await workspace.readFile(workspacePath('target'))).toBe('old');
    await importWorkspaceEntries(workspace, entries, { overwrite: true });
    expect(await workspace.readFile(workspacePath('target/new.txt'))).toBe('new');
  });
});

describe('strict unified-diff application', () => {
  it('applies multiple exact-context hunks without fuzz', () => {
    const result = applyStrictUnifiedPatch(
      'one\ntwo\nthree\nfour\n',
      [
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        '@@ -3,2 +3,3 @@',
        ' three',
        '+three-and-a-half',
        ' four',
        '',
      ].join('\n'),
    );
    expect(result).toEqual({
      content: 'one\nTWO\nthree\nthree-and-a-half\nfour\n',
      hunksApplied: 2,
    });
  });

  it('rejects context mismatch, overlapping hunks, and multi-file patches', () => {
    expect(() => applyStrictUnifiedPatch('actual\n', '@@ -1 +1 @@\n-expected\n+new\n')).toThrow(
      StrictPatchError,
    );
    expect(() =>
      applyStrictUnifiedPatch('a\nb\n', '@@ -1 +1 @@\n-a\n+A\n@@ -1 +1 @@\n-a\n+again\n'),
    ).toThrowError(expect.objectContaining({ code: 'OVERLAPPING_HUNKS' }));
    expect(() =>
      applyStrictUnifiedPatch(
        'a\n',
        '--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+A\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-a\n+B\n',
      ),
    ).toThrowError(expect.objectContaining({ code: 'MULTIPLE_FILES' }));
  });

  it('respects no-newline markers', () => {
    expect(
      applyStrictUnifiedPatch(
        'old',
        '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
      ).content,
    ).toBe('new');
  });

  it('does not write when a tool hunk fails validation', async () => {
    const workspace = createMemoryProjectWorkspace({
      entries: [{ path: workspacePath('file.txt'), kind: 'file', content: 'original\n' }],
    });
    const tool = createStrictApplyPatchTool(workspace);
    await expect(
      tool.execute({
        path: workspacePath('file.txt'),
        patch: '@@ -1 +1 @@\n-wrong\n+changed\n',
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(await workspace.readFile(workspacePath('file.txt'))).toBe('original\n');
  });
});
