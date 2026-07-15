import {
  FSA_LIST_FILES_TOOL_KEY,
  FSA_READ_FILE_TOOL_KEY,
  FSA_WORKSPACE_PLUGIN_ID,
  FSA_WORKSPACE_TOOL_CAPABILITY_IDS,
  FSA_WRITE_FILE_TOOL_KEY,
  FileSystemAccessWorkspaceError,
  createFileSystemAccessTextWorkspace,
  createFileSystemAccessWorkspacePlugin,
} from '../src/index.js';
import {
  WORKSPACE_OPERATIONS,
  workspacePath,
  type ListFilesTool,
  type ReadFileTool,
  type WriteFileTool,
} from '@loom/tool-workspace';
import { CancellationError, createCancellationSource, sessionId } from '@loom/types';
import { describe, expect, it } from 'vitest';

function hostError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

class FakeFileHandle {
  public readonly kind = 'file' as const;
  public content: string;
  public writeError: unknown;
  public abortError: unknown;
  public aborted = false;

  public constructor(
    public readonly name: string,
    content: string,
  ) {
    this.content = content;
  }

  public getFile(): Promise<File> {
    const content = this.content;
    return Promise.resolve({ text: () => Promise.resolve(content) } as File);
  }

  public createWritable(): Promise<FileSystemWritableFileStream> {
    let pending = this.content;
    const writable = {
      write: (value: FileSystemWriteChunkType) => {
        if (this.writeError !== undefined) throw this.writeError;
        if (typeof value !== 'string') throw new TypeError('The fake accepts string writes only.');
        pending = value;
        return Promise.resolve();
      },
      close: () => {
        this.content = pending;
        return Promise.resolve();
      },
      abort: () => {
        this.aborted = true;
        return this.abortError === undefined ? Promise.resolve() : Promise.reject(this.abortError);
      },
    };
    return Promise.resolve(writable as unknown as FileSystemWritableFileStream);
  }
}

type FakeEntry = FakeDirectoryHandle | FakeFileHandle;

class FakeDirectoryHandle {
  public readonly kind = 'directory' as const;
  public readonly children = new Map<string, FakeEntry>();
  public readonly directoryRequests: {
    readonly name: string;
    readonly options: FileSystemGetDirectoryOptions | undefined;
  }[] = [];
  public readonly fileErrors = new Map<string, unknown>();
  public entriesError: unknown;

  public constructor(public readonly name: string) {}

  public add(entry: FakeEntry): this {
    this.children.set(entry.name, entry);
    return this;
  }

  public async *entries(): AsyncIterableIterator<readonly [string, FileSystemHandle]> {
    if (this.entriesError !== undefined) throw this.entriesError;
    for (const [name, entry] of this.children) {
      yield [name, entry as unknown as FileSystemHandle] as const;
    }
  }

  public getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    this.directoryRequests.push({ name, options });
    const entry = this.children.get(name);
    if (entry === undefined) return Promise.reject(hostError('NotFoundError'));
    if (entry.kind !== 'directory') return Promise.reject(hostError('TypeMismatchError'));
    return Promise.resolve(entry as unknown as FileSystemDirectoryHandle);
  }

  public getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<FileSystemFileHandle> {
    const configuredError = this.fileErrors.get(name);
    if (configuredError !== undefined) return Promise.reject(configuredError);
    const entry = this.children.get(name);
    if (entry?.kind === 'directory') return Promise.reject(hostError('TypeMismatchError'));
    if (entry?.kind === 'file') return Promise.resolve(entry as unknown as FileSystemFileHandle);
    if (options?.create === true) {
      const created = new FakeFileHandle(name, '');
      this.children.set(name, created);
      return Promise.resolve(created as unknown as FileSystemFileHandle);
    }
    return Promise.reject(hostError('NotFoundError'));
  }
}

interface RegisteredFsaTools {
  readonly plugin: ReturnType<typeof createFileSystemAccessWorkspacePlugin>;
  readonly listFiles: ListFilesTool;
  readonly readFile: ReadFileTool;
  readonly writeFile: WriteFileTool;
  readonly registrations: { readonly key: unknown; readonly value: unknown }[];
}

async function registeredFsaTools(root: FakeDirectoryHandle): Promise<RegisteredFsaTools> {
  const plugin = createFileSystemAccessWorkspacePlugin(
    root as unknown as FileSystemDirectoryHandle,
  );
  const registrations: { readonly key: unknown; readonly value: unknown }[] = [];
  await plugin.initialize?.({
    capabilities: {
      register: (key: unknown, value: unknown) => registrations.push({ key, value }),
    },
  } as never);
  return {
    plugin,
    listFiles: registrations[0]?.value as ListFilesTool,
    readFile: registrations[1]?.value as ReadFileTool,
    writeFile: registrations[2]?.value as WriteFileTool,
    registrations,
  };
}

function fixtureRoot(): FakeDirectoryHandle {
  return new FakeDirectoryHandle('root')
    .add(new FakeFileHandle('z.txt', 'last'))
    .add(new FakeFileHandle('source.txt', 'hello'))
    .add(new FakeDirectoryHandle('src').add(new FakeFileHandle('main.ts', 'export {};')));
}

describe('File System Access text workspace', () => {
  it('lists immediate entries and reads nested UTF-8 text', async () => {
    const root = fixtureRoot();
    const workspace = createFileSystemAccessTextWorkspace(
      root as unknown as FileSystemDirectoryHandle,
    );

    await expect(workspace.listFiles(undefined)).resolves.toEqual([
      { path: 'source.txt', kind: 'file' },
      { path: 'src', kind: 'directory' },
      { path: 'z.txt', kind: 'file' },
    ]);
    await expect(workspace.listFiles(workspacePath('src'))).resolves.toEqual([
      { path: 'src/main.ts', kind: 'file' },
    ]);
    await expect(workspace.readFile(workspacePath('src/main.ts'))).resolves.toBe('export {};');
  });

  it('creates and replaces files without creating directories', async () => {
    const root = fixtureRoot();
    const workspace = createFileSystemAccessTextWorkspace(
      root as unknown as FileSystemDirectoryHandle,
    );

    await expect(workspace.writeFile(workspacePath('source.txt'), 'replaced')).resolves.toBe(false);
    await expect(workspace.writeFile(workspacePath('created.txt'), 'created')).resolves.toBe(true);
    await expect(workspace.readFile(workspacePath('source.txt'))).resolves.toBe('replaced');
    await expect(workspace.readFile(workspacePath('created.txt'))).resolves.toBe('created');
    await expect(workspace.writeFile(workspacePath('src'), 'no')).rejects.toMatchObject({
      code: 'EXPECTED_FILE',
      path: 'src',
    });

    await expect(workspace.writeFile(workspacePath('missing/new.txt'), 'no')).rejects.toMatchObject(
      {
        code: 'ENTRY_NOT_FOUND',
        path: 'missing',
      },
    );
    expect(root.directoryRequests.at(-1)).toEqual({ name: 'missing', options: undefined });
  });

  it('translates missing and mismatched entries into typed errors', async () => {
    const workspace = createFileSystemAccessTextWorkspace(
      fixtureRoot() as unknown as FileSystemDirectoryHandle,
    );
    await expect(workspace.readFile(workspacePath('absent.txt'))).rejects.toBeInstanceOf(
      FileSystemAccessWorkspaceError,
    );
    await expect(workspace.readFile(workspacePath('src'))).rejects.toMatchObject({
      code: 'EXPECTED_FILE',
      path: 'src',
    });
    await expect(workspace.listFiles(workspacePath('source.txt'))).rejects.toMatchObject({
      code: 'EXPECTED_DIRECTORY',
      path: 'source.txt',
    });
  });

  it('checks Loom cancellation before touching host handles', async () => {
    const root = fixtureRoot();
    const workspace = createFileSystemAccessTextWorkspace(
      root as unknown as FileSystemDirectoryHandle,
    );
    const cancellation = createCancellationSource();
    cancellation.cancel('closed');

    await expect(
      workspace.listFiles(workspacePath('src'), { signal: cancellation.signal }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(root.directoryRequests).toEqual([]);
  });

  it('registers explicit FSA tools while preserving operation discriminators', async () => {
    const { plugin, registrations } = await registeredFsaTools(fixtureRoot());

    expect(plugin.manifest.id).toBe(FSA_WORKSPACE_PLUGIN_ID);
    expect(registrations.map(({ key }) => key)).toEqual([
      FSA_LIST_FILES_TOOL_KEY,
      FSA_READ_FILE_TOOL_KEY,
      FSA_WRITE_FILE_TOOL_KEY,
    ]);
    expect(
      registrations.map(({ value }) => (value as { readonly operation: string }).operation),
    ).toEqual([
      WORKSPACE_OPERATIONS.listFiles,
      WORKSPACE_OPERATIONS.readFile,
      WORKSPACE_OPERATIONS.writeFile,
    ]);
    expect(FSA_LIST_FILES_TOOL_KEY.id).toBe(FSA_WORKSPACE_TOOL_CAPABILITY_IDS.listFiles);
    expect(FSA_READ_FILE_TOOL_KEY.id).toBe(FSA_WORKSPACE_TOOL_CAPABILITY_IDS.readFile);
    expect(FSA_WRITE_FILE_TOOL_KEY.id).toBe(FSA_WORKSPACE_TOOL_CAPABILITY_IDS.writeFile);
  });

  it('executes every registered FSA tool with typed results and context', async () => {
    const root = fixtureRoot();
    const { listFiles, readFile, writeFile } = await registeredFsaTools(root);
    const context = { sessionId: sessionId('fsa-tools') };

    await expect(listFiles.execute({ path: workspacePath('src') }, context)).resolves.toEqual({
      entries: [{ path: 'src/main.ts', kind: 'file' }],
    });
    await expect(readFile.execute({ path: workspacePath('source.txt') }, context)).resolves.toEqual(
      {
        path: 'source.txt',
        content: 'hello',
      },
    );
    await expect(
      writeFile.execute(
        { path: workspacePath('through-tool.txt'), content: 'tool output' },
        context,
      ),
    ).resolves.toEqual({ path: 'through-tool.txt', created: true });
    expect((root.children.get('through-tool.txt') as FakeFileHandle).content).toBe('tool output');

    const cancellation = createCancellationSource();
    cancellation.cancel('session closed');
    await expect(listFiles.execute({}, { signal: cancellation.signal })).rejects.toBeInstanceOf(
      CancellationError,
    );
  });

  it('rejects malformed inputs through each registered tool', async () => {
    const { listFiles, readFile, writeFile } = await registeredFsaTools(fixtureRoot());

    await expect(listFiles.execute(null as unknown as never)).rejects.toThrow(/object/u);
    await expect(listFiles.execute({ extra: true } as never)).rejects.toThrow(/unsupported/u);
    await expect(listFiles.execute({ path: 1 } as never)).rejects.toThrow(/string/u);
    await expect(readFile.execute({ extra: true } as never)).rejects.toThrow(/unsupported/u);
    await expect(readFile.execute({} as never)).rejects.toThrow(/path/u);
    await expect(writeFile.execute({ extra: true } as never)).rejects.toThrow(/unsupported/u);
    await expect(writeFile.execute({ content: 'missing path' } as never)).rejects.toThrow(/path/u);
    await expect(writeFile.execute({ path: 'missing-content.txt' } as never)).rejects.toThrow(
      /content/u,
    );
  });

  it('translates enumeration, host access, and writable failures', async () => {
    const root = fixtureRoot();
    const workspace = createFileSystemAccessTextWorkspace(
      root as unknown as FileSystemDirectoryHandle,
    );
    root.entriesError = new Error('enumeration failed');
    await expect(workspace.listFiles(undefined)).rejects.toMatchObject({ code: 'LIST_FAILED' });
    root.entriesError = undefined;

    root.fileErrors.set('broken-read.txt', new Error('read access failed'));
    await expect(workspace.readFile(workspacePath('broken-read.txt'))).rejects.toMatchObject({
      code: 'READ_FAILED',
    });
    root.fileErrors.set('broken-write.txt', new Error('write access failed'));
    await expect(
      workspace.writeFile(workspacePath('broken-write.txt'), 'content'),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });

    const file = new FakeFileHandle('write-stream.txt', 'before');
    file.writeError = new Error('stream failed');
    file.abortError = new Error('abort also failed');
    root.add(file);
    await expect(
      workspace.writeFile(workspacePath('write-stream.txt'), 'after'),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(file.aborted).toBe(true);
    expect(file.content).toBe('before');
  });

  it('rejects non-directory roots', () => {
    expect(() =>
      createFileSystemAccessTextWorkspace(
        new FakeFileHandle('file', '') as unknown as FileSystemDirectoryHandle,
      ),
    ).toThrow(FileSystemAccessWorkspaceError);
  });
});
