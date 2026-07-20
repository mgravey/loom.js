import { describe, expect, it, vi } from 'vitest';

import {
  createPyodideExecutionRuntime,
  createQuickJsExecutionRuntime,
  createWebContainerExecutionRuntime,
  executeBrowserWorkspace,
  type BrowserExecutionBackend,
  type BrowserExecutionError,
  type BrowserExecutionProject,
  type BrowserExecutionRequest,
  type BrowserExecutionRuntime,
} from '../src/index.js';

const encoder = new TextEncoder();

function project(content = 'console.log("hello")'): BrowserExecutionProject {
  return {
    directories: ['src'],
    files: [{ path: 'src/main.js', data: encoder.encode(content) }],
  };
}

function request(overrides: Partial<BrowserExecutionRequest> = {}): BrowserExecutionRequest {
  return {
    command: 'qjs',
    arguments: ['src/main.js'],
    project: project(),
    ...overrides,
  };
}

function backend(
  execute: BrowserExecutionBackend['execute'] = async (input) => ({
    exitCode: 0,
    project: input.project,
  }),
): BrowserExecutionBackend {
  return { execute, dispose: vi.fn() };
}

describe.each([
  ['quickjs', createQuickJsExecutionRuntime, 'quickjs-emscripten'],
  ['webcontainer', createWebContainerExecutionRuntime, '@webcontainer/api'],
  ['pyodide', createPyodideExecutionRuntime, 'pyodide'],
] as const)('%s lazy browser runtime', (kind, createRuntime, expectedModule) => {
  it('loads its optional runtime only on first execution and reuses its backend', async () => {
    const implementation = backend();
    const loadModule = vi.fn(async () => ({ runtime: kind }));
    const createBackend = vi.fn(() => implementation);
    const runtime = createRuntime({ loadModule, createBackend });

    expect(runtime.kind).toBe(kind);
    expect(loadModule).not.toHaveBeenCalled();

    await runtime.execute(request());
    await runtime.execute(request());

    expect(loadModule).toHaveBeenCalledOnce();
    expect(loadModule).toHaveBeenCalledWith(expectedModule);
    expect(createBackend).toHaveBeenCalledOnce();
    expect(implementation.execute).toBeDefined();
  });

  it('disposes a loaded backend exactly once and rejects later execution', async () => {
    const implementation = backend();
    const runtime = createRuntime({
      loadModule: async () => ({}),
      createBackend: () => implementation,
    });
    await runtime.execute(request());

    await runtime.dispose();
    await runtime.dispose();

    expect(implementation.dispose).toHaveBeenCalledOnce();
    await expect(runtime.execute(request())).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

describe('credential-free execution boundary', () => {
  it('rejects unknown environment and credential-bearing request fields before loading a runtime', async () => {
    const loadModule = vi.fn(async () => ({}));
    const runtime = createQuickJsExecutionRuntime({
      loadModule,
      createBackend: () => backend(),
    });

    await expect(
      runtime.execute({
        ...request(),
        environment: { OPENAI_TOKEN: 'secret' },
      } as BrowserExecutionRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      runtime.execute({
        ...request(),
        accessToken: 'secret',
      } as BrowserExecutionRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('copies project bytes across the runtime boundary', async () => {
    const source = encoder.encode('original');
    let observed = '';
    const runtime = createQuickJsExecutionRuntime({
      loadModule: async () => ({}),
      createBackend: () =>
        backend(async (input) => {
          observed = new TextDecoder().decode(input.project.files[0]?.data);
          const output = input.project.files[0]?.data;
          if (output !== undefined) output[0] = 88;
          return { exitCode: 0, project: input.project };
        }),
    });

    const pending = runtime.execute(
      request({ project: { files: [{ path: 'main.js', data: source }] } }),
    );
    source.fill(90);
    const result = await pending;

    expect(observed).toBe('original');
    expect(source.every((value) => value === 90)).toBe(true);
    expect(result.project.files[0]?.data).not.toBe(source);
  });

  it.each([
    [{ files: [{ path: '../secret', data: new Uint8Array() }] }, 'INVALID_PROJECT'],
    [
      {
        directories: ['src'],
        files: [{ path: 'src', data: new Uint8Array() }],
      },
      'INVALID_PROJECT',
    ],
    [
      {
        files: [
          { path: 'same', data: new Uint8Array() },
          { path: 'same', data: new Uint8Array() },
        ],
      },
      'INVALID_PROJECT',
    ],
  ])('rejects unsafe or conflicting projects %#', async (unsafeProject, code) => {
    const runtime = createQuickJsExecutionRuntime({
      loadModule: async () => ({}),
      createBackend: () => backend(),
    });
    await expect(runtime.execute(request({ project: unsafeProject }))).rejects.toMatchObject({
      code,
    });
  });

  it('serializes executions against a stateful browser runtime', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime = createWebContainerExecutionRuntime({
      loadModule: async () => ({}),
      createBackend: () =>
        backend(async (input) => {
          order.push(`start:${input.command}`);
          if (input.command === 'first') {
            markStarted?.();
            await firstGate;
          }
          order.push(`end:${input.command}`);
          return { exitCode: 0, project: input.project };
        }),
    });

    const first = runtime.execute(request({ command: 'first' }));
    const second = runtime.execute(request({ command: 'second' }));
    await started;
    expect(order).toEqual(['start:first']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('contains output-listener failures', async () => {
    const runtime = createPyodideExecutionRuntime({
      loadModule: async () => ({}),
      createBackend: () =>
        backend(async (input, context) => {
          expect(() => context.onOutput?.({ channel: 'stdout', chunk: 'hello' })).toThrow('sink');
          return { exitCode: 0, project: input.project };
        }),
    });

    // Backends normally use the package's guarded emitter; the public runtime preserves the sink.
    await expect(
      runtime.execute(request(), {
        onOutput: () => {
          throw new Error('sink');
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe('WebContainer adapter', () => {
  it('mounts a copied project, streams output, exports changes, and tears down', async () => {
    const calls: string[] = [];
    const teardown = vi.fn();
    const instance = {
      fs: {
        mkdir: vi.fn(async (path: string) => {
          calls.push(`mkdir:${path}`);
        }),
        rm: vi.fn(async (path: string) => {
          calls.push(`rm:${path}`);
        }),
      },
      mount: vi.fn(async (_tree: unknown, options: { mountPoint?: string }) => {
        calls.push(`mount:${options.mountPoint ?? ''}`);
      }),
      spawn: vi.fn(
        async (command: string, arguments_: readonly string[], options: { cwd?: string }) => {
          calls.push(`spawn:${command}:${arguments_.join(',')}:${options.cwd ?? ''}`);
          const output = new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`${command} output\n`);
              controller.close();
            },
          });
          return { output, exit: Promise.resolve(0), kill: vi.fn() };
        },
      ),
      export: vi.fn(async () => ({
        src: {
          directory: {
            'main.js': { file: { contents: encoder.encode('changed') } },
            'generated.txt': { file: { contents: 'done' } },
            'package.json': { file: { contents: '{"dependencies":{"kleur":"4.1.5"}}' } },
            node_modules: {
              directory: { kleur: { directory: { 'index.js': { file: { contents: 'cache' } } } } },
            },
          },
        },
      })),
      teardown,
    };
    const boot = vi.fn(async () => instance);
    const chunks: string[] = [];
    const runtime = createWebContainerExecutionRuntime({
      coep: 'credentialless',
      loadModule: async () => ({ WebContainer: { boot } }),
    });

    const result = await runtime.execute(
      request({
        command: 'node',
        arguments: ['main.js'],
        workingDirectory: 'src',
        project: {
          directories: ['src'],
          files: [
            { path: 'src/main.js', data: encoder.encode('console.log("hello")') },
            {
              path: 'src/package.json',
              data: encoder.encode('{"dependencies":{"kleur":"4.1.5"}}'),
            },
          ],
        },
      }),
      { onOutput: ({ chunk }) => chunks.push(chunk) },
    );
    await runtime.dispose();

    expect(boot).toHaveBeenCalledWith({ coep: 'credentialless' });
    expect(calls).toEqual([
      'mkdir:.loom-runs/run-1',
      'mount:.loom-runs/run-1',
      'spawn:npm:install:.loom-runs/run-1/src',
      'spawn:node:main.js:.loom-runs/run-1/src',
      'rm:.loom-runs/run-1',
    ]);
    expect(chunks).toEqual(['npm output\n', 'node output\n']);
    expect(
      result.project.files.map((file) => [file.path, new TextDecoder().decode(file.data)]),
    ).toEqual([
      ['src/generated.txt', 'done'],
      ['src/main.js', 'changed'],
      ['src/package.json', '{"dependencies":{"kleur":"4.1.5"}}'],
    ]);
    expect(teardown).toHaveBeenCalledOnce();
  });
});

describe('Pyodide adapter', () => {
  it('loads packages imported by the entrypoint before executing it', async () => {
    const directories = new Set(['/home', '/home/pyodide']);
    const files = new Map<string, Uint8Array>();
    const mkdirTree = (path: string): void => {
      let current = '';
      for (const segment of path.split('/').filter(Boolean)) {
        current += `/${segment}`;
        directories.add(current);
      }
    };
    const children = (path: string): string[] => {
      const prefix = `${path}/`;
      return [...directories, ...files.keys()]
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => candidate.slice(prefix.length).split('/')[0])
        .filter((name): name is string => name !== undefined && name !== '')
        .filter((name, index, values) => values.indexOf(name) === index);
    };
    const globalValues = new Map<string, unknown>();
    const loadPackage = vi.fn(async () => undefined);
    const loadPackagesFromImports = vi.fn(async () => undefined);
    const fileSystem = {
      mkdirTree,
      writeFile(path: string, data: Uint8Array) {
        mkdirTree(path.slice(0, path.lastIndexOf('/')));
        files.set(path, new Uint8Array(data));
      },
      readFile(path: string) {
        const data = files.get(path);
        if (data === undefined) throw new Error(`missing file ${path}`);
        return new Uint8Array(data);
      },
      readdir: (path: string) => ['.', '..', ...children(path)],
      stat: (path: string) => ({ mode: directories.has(path) ? 1 : 0 }),
      isDir: (mode: number) => mode === 1,
      unlink: (path: string) => void files.delete(path),
      rmdir: (path: string) => void directories.delete(path),
      chdir: vi.fn(),
    };
    const runPythonAsync = vi.fn(async (code: string) => {
      if (code.includes('print(np.arange(3))')) globalValues.delete('__loom_argv');
      if (code.includes('micropip.install')) globalValues.delete('__loom_packages');
      if (!code.includes('__loom_figure.savefig')) return;
      const directory = globalValues.get('__loom_figure_directory');
      const prefix = globalValues.get('__loom_figure_prefix');
      if (typeof directory !== 'string' || typeof prefix !== 'string') return;
      fileSystem.mkdirTree(directory);
      fileSystem.writeFile(`${directory}/${prefix}-figure-1.png`, encoder.encode('png'));
    });
    const instance = {
      FS: fileSystem,
      globals: {
        set(name: string, value: unknown) {
          globalValues.set(name, value);
        },
        delete(name: string) {
          if (!globalValues.has(name)) throw new Error(`KeyError: '${name}'`);
          return globalValues.delete(name);
        },
      },
      setStdout: vi.fn(),
      setStderr: vi.fn(),
      loadPackage,
      loadPackagesFromImports,
      runPythonAsync,
    };
    const runtime = createPyodideExecutionRuntime({
      loadModule: async () => ({ loadPyodide: async () => instance }),
      createInterruptBuffer: () => undefined,
    });
    const source = 'import numpy as np\nprint(np.arange(3))\n';

    const result = await runtime.execute({
      command: 'python',
      arguments: ['main.py'],
      project: { files: [{ path: 'main.py', data: encoder.encode(source) }] },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      artifacts: [{ path: '.loom/figures/run-1-figure-1.png', mediaType: 'image/png' }],
    });
    await expect(
      runtime.execute({
        command: 'micropip',
        arguments: ['snowballstemmer==2.2.0'],
        project: { files: [] },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(loadPackage).toHaveBeenNthCalledWith(1, ['numpy', 'matplotlib']);
    expect(loadPackage).toHaveBeenNthCalledWith(2, 'micropip');
    expect(loadPackagesFromImports).toHaveBeenCalledOnce();
    expect(loadPackagesFromImports).toHaveBeenCalledWith(source);
    expect(loadPackagesFromImports.mock.invocationCallOrder[0]).toBeLessThan(
      runPythonAsync.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runPythonAsync).toHaveBeenCalledWith(
      'import micropip\nawait micropip.install(list(__loom_packages))',
    );
  });
});

describe('browser workspace execution integration', () => {
  function runtimeWithProject(output: BrowserExecutionProject): BrowserExecutionRuntime {
    return {
      kind: 'quickjs',
      execute: vi.fn(async () => ({ exitCode: 0, project: output })),
      dispose: vi.fn(async () => undefined),
    };
  }

  it('snapshots, executes, and commits the resulting project', async () => {
    const input = project('input');
    const output = project('output');
    const runtime = runtimeWithProject(output);
    const workspace = {
      load: vi.fn(async () => input),
      commit: vi.fn(async () => undefined),
    };

    const result = await executeBrowserWorkspace(
      runtime,
      workspace,
      { command: 'qjs', arguments: ['src/main.js'], timeoutMs: 500 },
      {},
    );

    expect(runtime.execute).toHaveBeenCalledWith(
      {
        command: 'qjs',
        arguments: ['src/main.js'],
        timeoutMs: 500,
        project: input,
      },
      {},
    );
    expect(workspace.commit).toHaveBeenCalledWith(output, {});
    expect(result.project).toBe(output);
  });

  it('reports snapshot and commit failures without losing the original cause', async () => {
    const failure = new Error('conflict');
    const output = project('output');
    const runtime = runtimeWithProject(output);
    const loadFailure = {
      load: vi.fn(async () => Promise.reject(failure)),
      commit: vi.fn(async () => undefined),
    };
    await expect(executeBrowserWorkspace(runtime, loadFailure, { command: 'qjs' })).rejects.toEqual(
      expect.objectContaining<Partial<BrowserExecutionError>>({
        code: 'WORKSPACE_SYNC_FAILED',
        cause: failure,
      }),
    );

    const commitFailure = {
      load: vi.fn(async () => project()),
      commit: vi.fn(async () => Promise.reject(failure)),
    };
    await expect(
      executeBrowserWorkspace(runtime, commitFailure, { command: 'qjs' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserExecutionError>>({
        code: 'WORKSPACE_SYNC_FAILED',
        cause: failure,
      }),
    );
  });
});
