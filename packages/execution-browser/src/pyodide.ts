import type {
  BrowserExecutionBackendFactory,
  BrowserExecutionContext,
  BrowserExecutionProject,
  BrowserExecutionRequest,
  BrowserRuntimeModuleLoader,
} from './contracts.js';
import { BrowserExecutionError } from './errors.js';
import { createLazyBrowserRuntime } from './lazy-runtime.js';
import { cancellationError, copyProject, emitOutput, executionPath } from './validation.js';

const PYODIDE_MODULE_SPECIFIER = 'pyodide';
const PYTHON_COMMANDS = new Set(['python', 'python3', 'pyodide']);

interface PyodideFileSystem {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, options: { readonly encoding: 'binary' }): Uint8Array;
  readdir(path: string): readonly string[];
  stat(path: string): { readonly mode: number };
  isDir(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  chdir(path: string): void;
}

interface PyodideGlobals {
  set(name: string, value: unknown): void;
  delete(name: string): boolean;
}

interface PyodideInstance {
  readonly FS: PyodideFileSystem;
  readonly globals: PyodideGlobals;
  setStdout(options: { readonly batched: (text: string) => void }): void;
  setStderr(options: { readonly batched: (text: string) => void }): void;
  setInterruptBuffer?(buffer: Int32Array): void;
  runPythonAsync(source: string, options?: { readonly filename?: string }): Promise<unknown>;
}

interface PyodidePackageModule {
  loadPyodide(options?: { readonly indexURL?: string }): Promise<PyodideInstance>;
}

export interface CreatePyodideExecutionRuntimeOptions {
  readonly loadModule?: BrowserRuntimeModuleLoader;
  readonly createBackend?: BrowserExecutionBackendFactory;
  readonly indexURL?: string;
  readonly createInterruptBuffer?: () => Int32Array | undefined;
}

function assertModule(value: unknown): asserts value is PyodidePackageModule {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('loadPyodide' in value) ||
    typeof value.loadPyodide !== 'function'
  ) {
    throw new BrowserExecutionError('RUNTIME_LOAD_FAILED', 'pyodide did not expose loadPyodide().');
  }
}

function textFile(project: BrowserExecutionProject, path: string): string {
  const file = project.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      `Python entrypoint '${path}' was not found.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.data);
  } catch (error) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      `Python entrypoint '${path}' is not valid UTF-8 text.`,
      { cause: error },
    );
  }
}

function ensureParentDirectories(fs: PyodideFileSystem, root: string, path: string): void {
  const separator = path.lastIndexOf('/');
  if (separator >= 0) fs.mkdirTree(`${root}/${path.slice(0, separator)}`);
}

function mountProject(fs: PyodideFileSystem, root: string, project: BrowserExecutionProject): void {
  fs.mkdirTree(root);
  for (const directory of project.directories ?? []) fs.mkdirTree(`${root}/${directory}`);
  for (const file of project.files) {
    ensureParentDirectories(fs, root, file.path);
    fs.writeFile(`${root}/${file.path}`, new Uint8Array(file.data));
  }
}

function exportProject(fs: PyodideFileSystem, root: string): BrowserExecutionProject {
  const directories: string[] = [];
  const files: { path: string; data: Uint8Array }[] = [];
  const visit = (absolute: string, relative: string): void => {
    for (const name of fs.readdir(absolute)) {
      if (name === '.' || name === '..') continue;
      const childAbsolute = `${absolute}/${name}`;
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      executionPath(childRelative);
      if (fs.isDir(fs.stat(childAbsolute).mode)) {
        directories.push(childRelative);
        visit(childAbsolute, childRelative);
      } else {
        files.push({
          path: childRelative,
          data: new Uint8Array(fs.readFile(childAbsolute, { encoding: 'binary' })),
        });
      }
    }
  };
  visit(root, '');
  return copyProject({ directories, files });
}

function removeTree(fs: PyodideFileSystem, path: string): void {
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) removeTree(fs, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}

function defaultInterruptBuffer(): Int32Array | undefined {
  if (typeof SharedArrayBuffer === 'undefined') return undefined;
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

function createPyodideBackend(
  indexURL: string | undefined,
  createInterruptBuffer: () => Int32Array | undefined,
): BrowserExecutionBackendFactory {
  return async (module) => {
    assertModule(module);
    const pyodide = await module.loadPyodide(indexURL === undefined ? {} : { indexURL });
    let sequence = 0;
    return Object.freeze({
      async execute(request: BrowserExecutionRequest, context: BrowserExecutionContext) {
        if (!PYTHON_COMMANDS.has(request.command)) {
          throw new BrowserExecutionError(
            'UNSUPPORTED_COMMAND',
            "Pyodide accepts only 'python', 'python3', or 'pyodide'.",
          );
        }
        const [entrypoint, ...scriptArguments] = request.arguments ?? [];
        if (entrypoint === undefined) {
          throw new BrowserExecutionError(
            'INVALID_REQUEST',
            'Pyodide requires an entrypoint argument.',
          );
        }
        const normalizedEntrypoint = executionPath(
          request.workingDirectory === undefined || request.workingDirectory.length === 0
            ? entrypoint
            : `${request.workingDirectory}/${entrypoint}`,
        );
        const source = textFile(request.project, normalizedEntrypoint);
        sequence += 1;
        const root = `/home/pyodide/.loom-runs/run-${String(sequence)}`;
        mountProject(pyodide.FS, root, request.project);
        const cwd =
          request.workingDirectory === undefined || request.workingDirectory.length === 0
            ? root
            : `${root}/${request.workingDirectory}`;
        const interrupt = createInterruptBuffer();
        if (interrupt !== undefined) {
          interrupt[0] = 0;
          pyodide.setInterruptBuffer?.(interrupt);
        }
        const executionState = { timedOut: false };
        const interruptExecution = (): void => {
          if (interrupt !== undefined) Atomics.store(interrupt, 0, 2);
        };
        const unsubscribe = context.signal?.onCancel(interruptExecution) ?? (() => undefined);
        const timer =
          request.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                executionState.timedOut = true;
                interruptExecution();
              }, request.timeoutMs);
        pyodide.setStdout({ batched: (text) => emitOutput(context, 'stdout', `${text}\n`) });
        pyodide.setStderr({ batched: (text) => emitOutput(context, 'stderr', `${text}\n`) });
        try {
          context.signal?.throwIfCancelled();
          pyodide.FS.chdir(cwd);
          pyodide.globals.set('__loom_argv', [request.command, entrypoint, ...scriptArguments]);
          await pyodide.runPythonAsync('import sys\nsys.argv = list(__loom_argv)');
          await pyodide.runPythonAsync(source, { filename: normalizedEntrypoint });
          if (context.signal?.cancelled === true) throw cancellationError(context.signal.reason);
          if (executionState.timedOut) {
            throw new BrowserExecutionError(
              'TIMED_OUT',
              `Pyodide execution exceeded ${String(request.timeoutMs)} ms.`,
            );
          }
          return Object.freeze({ exitCode: 0, project: exportProject(pyodide.FS, root) });
        } catch (error) {
          if (context.signal?.cancelled === true) throw cancellationError(context.signal.reason);
          if (executionState.timedOut) {
            throw new BrowserExecutionError(
              'TIMED_OUT',
              `Pyodide execution exceeded ${String(request.timeoutMs)} ms.`,
              { cause: error },
            );
          }
          if (error instanceof BrowserExecutionError) throw error;
          emitOutput(
            context,
            'stderr',
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
          return Object.freeze({ exitCode: 1, project: exportProject(pyodide.FS, root) });
        } finally {
          unsubscribe();
          if (timer !== undefined) clearTimeout(timer);
          pyodide.globals.delete('__loom_argv');
          pyodide.setStdout({ batched: () => undefined });
          pyodide.setStderr({ batched: () => undefined });
          pyodide.FS.chdir('/home/pyodide');
          removeTree(pyodide.FS, root);
        }
      },
      dispose: () => undefined,
    });
  };
}

export function createPyodideExecutionRuntime(options: CreatePyodideExecutionRuntimeOptions = {}) {
  return createLazyBrowserRuntime({
    kind: 'pyodide',
    moduleSpecifier: PYODIDE_MODULE_SPECIFIER,
    ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
    createBackend:
      options.createBackend ??
      createPyodideBackend(
        options.indexURL,
        options.createInterruptBuffer ?? defaultInterruptBuffer,
      ),
  });
}
