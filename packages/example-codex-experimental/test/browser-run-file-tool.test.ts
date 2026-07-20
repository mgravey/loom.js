import { describe, expect, it, vi } from 'vitest';

import type { BrowserExecutionRuntime } from '@loom/execution-browser';
import { createMemoryProjectWorkspace, workspacePath } from '@loom/tool-workspace';

import {
  createBrowserInstallPackagesTool,
  createBrowserRunFileTool,
} from '../src/browser-run-file-tool.js';

describe('website browser run-file tool', () => {
  it('executes the selected workspace file and returns captured process output', async () => {
    const workspace = createMemoryProjectWorkspace();
    await workspace.writeFile(
      workspacePath('numpy_example.py'),
      'import numpy as np\nprint(np.arange(3))\n',
    );
    await workspace.createDirectory(workspacePath('.loom/conversations'), { recursive: true });
    await workspace.writeFile(
      workspacePath('.loom/conversations/conversation-private.json'),
      '{"private":true}\n',
    );
    const persist = vi.fn(async () => undefined);
    const execute = vi.fn<BrowserExecutionRuntime['execute']>(async (request, context) => {
      expect(request.command).toBe('python');
      expect(request.arguments).toEqual(['numpy_example.py', '--verbose']);
      expect(request.timeoutMs).toBe(20_000);
      expect(
        new TextDecoder().decode(
          request.project.files.find((file) => file.path === 'numpy_example.py')?.data,
        ),
      ).toContain('import numpy as np');
      expect(
        request.project.files.some((file) => file.path.startsWith('.loom/conversations/')),
      ).toBe(false);
      context?.onOutput?.({ channel: 'stdout', chunk: '[0 1 2]\n' });
      context?.onOutput?.({ channel: 'stderr', chunk: 'warning\n' });
      return {
        exitCode: 0,
        project: {
          directories: [...(request.project.directories ?? []), '.loom', '.loom/figures'],
          files: [
            ...request.project.files,
            { path: '.loom/figures/run-1-figure-1.png', data: new TextEncoder().encode('png') },
          ],
        },
        artifacts: [{ path: '.loom/figures/run-1-figure-1.png', mediaType: 'image/png' }],
      };
    });
    const runtime: BrowserExecutionRuntime = {
      kind: 'pyodide',
      execute,
      dispose: vi.fn(async () => undefined),
    };
    const tool = createBrowserRunFileTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
      persist,
    });

    await expect(
      tool.execute({
        runtime: 'python',
        path: 'numpy_example.py',
        arguments: ['--verbose'],
        timeoutMs: 20_000,
      }),
    ).resolves.toEqual({
      runtime: 'python',
      path: 'numpy_example.py',
      exitCode: 0,
      stdout: '[0 1 2]\n',
      stderr: 'warning\n',
      artifacts: [{ path: '.loom/figures/run-1-figure-1.png', mediaType: 'image/png' }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    await expect(
      workspace.readFile(workspacePath('.loom/conversations/conversation-private.json')),
    ).resolves.toContain('private');
  });

  it('rejects unsupported inputs before starting a runtime', async () => {
    const workspace = createMemoryProjectWorkspace();
    const execute = vi.fn<BrowserExecutionRuntime['execute']>();
    const runtime: BrowserExecutionRuntime = {
      kind: 'quickjs',
      execute,
      dispose: vi.fn(async () => undefined),
    };
    const tool = createBrowserRunFileTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
    });

    await expect(tool.execute({ runtime: 'ruby', path: 'main.rb' })).rejects.toThrow(
      "runtime must be 'quickjs', 'node', or 'python'",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute when the website denies workspace write-back', async () => {
    const workspace = createMemoryProjectWorkspace();
    const execute = vi.fn<BrowserExecutionRuntime['execute']>();
    const runtime: BrowserExecutionRuntime = {
      kind: 'quickjs',
      execute,
      dispose: vi.fn(async () => undefined),
    };
    const tool = createBrowserRunFileTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
      authorizeWriteBack: () => false,
    });

    await expect(tool.execute({ runtime: 'quickjs', path: 'main.js' })).rejects.toThrow(
      'did not authorize runtime write-back',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs read-only snapshots without committing runtime file changes', async () => {
    const workspace = createMemoryProjectWorkspace();
    await workspace.writeFile(workspacePath('main.js'), 'console.log("before");\n');
    const persist = vi.fn(async () => undefined);
    const runtime: BrowserExecutionRuntime = {
      kind: 'quickjs',
      async execute() {
        return {
          exitCode: 0,
          project: {
            files: [
              { path: 'main.js', data: new TextEncoder().encode('console.log("changed");\n') },
              { path: '.loom/figures/run-1-figure-1.png', data: new Uint8Array([1, 2, 3]) },
            ],
          },
          artifacts: [{ path: '.loom/figures/run-1-figure-1.png', mediaType: 'image/png' }],
        };
      },
      dispose: async () => undefined,
    };
    const tool = createBrowserRunFileTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
      writeBack: false,
      persist,
    });

    await expect(tool.execute({ runtime: 'quickjs', path: 'main.js' })).resolves.toMatchObject({
      exitCode: 0,
      artifacts: [],
    });
    await expect(workspace.readFile(workspacePath('main.js'))).resolves.toBe(
      'console.log("before");\n',
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it('bounds large stdout and stderr returned to the model', async () => {
    const workspace = createMemoryProjectWorkspace();
    await workspace.writeFile(workspacePath('main.js'), 'console.log("hello");\n');
    const runtime: BrowserExecutionRuntime = {
      kind: 'quickjs',
      async execute(request, context) {
        context?.onOutput?.({ channel: 'stdout', chunk: 'abcdefgh' });
        context?.onOutput?.({ channel: 'stderr', chunk: '12345678' });
        return { exitCode: 1, project: request.project };
      },
      dispose: async () => undefined,
    };
    const tool = createBrowserRunFileTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
      maxOutputCharacters: 4,
    });

    await expect(tool.execute({ runtime: 'quickjs', path: 'main.js' })).resolves.toMatchObject({
      exitCode: 1,
      stdout: 'abcd\n[output truncated]',
      stderr: '1234\n[output truncated]',
    });
  });

  it.each([
    ['python', 'micropip', ['httpx==0.28.1'], 'httpx==0.28.1'],
    ['node', 'npm', ['install', '--save', '--', 'kleur@4.1.5'], 'kleur@4.1.5'],
  ] as const)(
    'installs validated %s registry packages',
    async (runtimeId, command, arguments_, requirement) => {
      const workspace = createMemoryProjectWorkspace();
      const execute = vi.fn<BrowserExecutionRuntime['execute']>(async (request, context) => {
        context?.onOutput?.({ channel: 'stdout', chunk: 'installed\n' });
        return { exitCode: 0, project: request.project };
      });
      const runtime: BrowserExecutionRuntime = {
        kind: runtimeId === 'python' ? 'pyodide' : 'webcontainer',
        execute,
        dispose: vi.fn(async () => undefined),
      };
      const tool = createBrowserInstallPackagesTool({
        workspace,
        runtimes: { quickjs: runtime, node: runtime, python: runtime },
      });

      await expect(tool.execute({ runtime: runtimeId, packages: [requirement] })).resolves.toEqual({
        runtime: runtimeId,
        packages: [requirement],
        exitCode: 0,
        stdout: 'installed\n',
        stderr: '',
      });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ command, arguments: arguments_ }),
        expect.any(Object),
      );
    },
  );

  it('rejects package URLs and command-like requirements before installation', async () => {
    const workspace = createMemoryProjectWorkspace();
    const execute = vi.fn<BrowserExecutionRuntime['execute']>();
    const runtime: BrowserExecutionRuntime = {
      kind: 'pyodide',
      execute,
      dispose: vi.fn(async () => undefined),
    };
    const tool = createBrowserInstallPackagesTool({
      workspace,
      runtimes: { quickjs: runtime, node: runtime, python: runtime },
    });

    await expect(
      tool.execute({ runtime: 'python', packages: ['https://untrusted.example/pkg.whl'] }),
    ).rejects.toThrow('registry package requirements');
    await expect(tool.execute({ runtime: 'node', packages: ['--ignore-scripts'] })).rejects.toThrow(
      'registry package requirements',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
