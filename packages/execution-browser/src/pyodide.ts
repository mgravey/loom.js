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
const PYTHON_PACKAGE_COMMANDS = new Set(['micropip', 'pip', 'pip3']);
const DEFAULT_PYODIDE_PACKAGES = Object.freeze(['numpy', 'matplotlib']);

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
  loadPackage(packages: string | readonly string[]): Promise<void>;
  loadPackagesFromImports(source: string): Promise<void>;
  runPythonAsync(source: string, options?: { readonly filename?: string }): Promise<unknown>;
}

interface PyodidePackageModule {
  loadPyodide(options?: { readonly indexURL?: string }): Promise<PyodideInstance>;
}

export interface CreatePyodideExecutionRuntimeOptions {
  readonly loadModule?: BrowserRuntimeModuleLoader;
  readonly createBackend?: BrowserExecutionBackendFactory;
  readonly indexURL?: string;
  /** Packages loaded once with the runtime. Defaults to NumPy and Matplotlib. */
  readonly defaultPackages?: readonly string[];
  readonly createInterruptBuffer?: () => Int32Array | undefined;
}

const MATPLOTLIB_PRELUDE = `
import matplotlib as __loom_matplotlib
__loom_matplotlib.use("Agg")
import matplotlib.pyplot as __loom_plt
def __loom_show(*args, **kwargs):
    return None
__loom_plt.show = __loom_show
`;

const MATPLOTLIB_CAPTURE = `
import os as __loom_os
__loom_os.makedirs(__loom_figure_directory, exist_ok=True)
for __loom_index, __loom_number in enumerate(__loom_plt.get_fignums(), start=1):
    __loom_figure = __loom_plt.figure(__loom_number)
    __loom_figure.savefig(
        f"{__loom_figure_directory}/{__loom_figure_prefix}-figure-{__loom_index}.png",
        format="png",
        bbox_inches="tight",
    )
__loom_plt.close("all")
`;

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

function validatedDefaultPackages(value: readonly string[] | undefined): readonly string[] {
  const packages = value ?? DEFAULT_PYODIDE_PACKAGES;
  if (
    packages.length > 64 ||
    packages.some(
      (name) =>
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 256 ||
        name.startsWith('-') ||
        /[\s\0]/u.test(name),
    )
  ) {
    throw new TypeError('Pyodide default packages must be bounded package names.');
  }
  return Object.freeze(packages.map((packageName) => packageName));
}

function createPyodideBackend(
  indexURL: string | undefined,
  defaultPackages: readonly string[],
  createInterruptBuffer: () => Int32Array | undefined,
): BrowserExecutionBackendFactory {
  return async (module) => {
    assertModule(module);
    const pyodide = await module.loadPyodide(indexURL === undefined ? {} : { indexURL });
    if (defaultPackages.length > 0) await pyodide.loadPackage(defaultPackages);
    let sequence = 0;
    return Object.freeze({
      async execute(request: BrowserExecutionRequest, context: BrowserExecutionContext) {
        const installsPackages = PYTHON_PACKAGE_COMMANDS.has(request.command);
        if (!PYTHON_COMMANDS.has(request.command) && !installsPackages) {
          throw new BrowserExecutionError(
            'UNSUPPORTED_COMMAND',
            "Pyodide accepts Python execution or the 'micropip' package installer.",
          );
        }
        const [entrypoint, ...scriptArguments] = request.arguments ?? [];
        if (!installsPackages && entrypoint === undefined) {
          throw new BrowserExecutionError(
            'INVALID_REQUEST',
            'Pyodide requires an entrypoint argument.',
          );
        }
        if (installsPackages && entrypoint === undefined) {
          throw new BrowserExecutionError(
            'INVALID_REQUEST',
            'Micropip requires at least one package requirement.',
          );
        }
        let normalizedEntrypoint: string | undefined;
        if (!installsPackages && entrypoint !== undefined) {
          normalizedEntrypoint = executionPath(
            request.workingDirectory === undefined || request.workingDirectory.length === 0
              ? entrypoint
              : `${request.workingDirectory}/${entrypoint}`,
          );
        }
        const source =
          normalizedEntrypoint === undefined
            ? undefined
            : textFile(request.project, normalizedEntrypoint);
        sequence += 1;
        const root = `/home/pyodide/.loom-runs/run-${String(sequence)}`;
        mountProject(pyodide.FS, root, request.project);
        const cwd =
          request.workingDirectory === undefined || request.workingDirectory.length === 0
            ? root
            : `${root}/${request.workingDirectory}`;
        const temporaryGlobals = new Set<string>();
        const setTemporaryGlobal = (name: string, value: unknown): void => {
          pyodide.globals.set(name, value);
          temporaryGlobals.add(name);
        };
        let capturesFigures = false;
        const captureFigures = async (): Promise<void> => {
          const figureDirectory = `${root}/.loom/figures`;
          const figurePrefix = `run-${String(sequence)}`;
          setTemporaryGlobal('__loom_figure_directory', figureDirectory);
          setTemporaryGlobal('__loom_figure_prefix', figurePrefix);
          await pyodide.runPythonAsync(MATPLOTLIB_CAPTURE);
        };
        const executionResult = (exitCode: number) => {
          const project = exportProject(pyodide.FS, root);
          const artifactPrefix = `.loom/figures/run-${String(sequence)}-`;
          const artifacts = project.files
            .filter((file) => file.path.startsWith(artifactPrefix) && file.path.endsWith('.png'))
            .map((file) => Object.freeze({ path: file.path, mediaType: 'image/png' }));
          return Object.freeze({
            exitCode,
            project,
            ...(artifacts.length === 0 ? {} : { artifacts: Object.freeze(artifacts) }),
          });
        };
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
          if (installsPackages) {
            setTemporaryGlobal('__loom_packages', [entrypoint, ...scriptArguments]);
            await pyodide.loadPackage('micropip');
            await pyodide.runPythonAsync(
              'import micropip\nawait micropip.install(list(__loom_packages))',
            );
          } else if (source !== undefined && normalizedEntrypoint !== undefined) {
            setTemporaryGlobal('__loom_argv', [request.command, entrypoint, ...scriptArguments]);
            await pyodide.loadPackagesFromImports(source);
            capturesFigures =
              defaultPackages.includes('matplotlib') || /\bmatplotlib\b/u.test(source);
            if (capturesFigures) await pyodide.runPythonAsync(MATPLOTLIB_PRELUDE);
            await pyodide.runPythonAsync('import sys\nsys.argv = list(__loom_argv)');
            await pyodide.runPythonAsync(source, { filename: normalizedEntrypoint });
            if (capturesFigures) await captureFigures();
          }
          if (context.signal?.cancelled === true) throw cancellationError(context.signal.reason);
          if (executionState.timedOut) {
            throw new BrowserExecutionError(
              'TIMED_OUT',
              `Pyodide execution exceeded ${String(request.timeoutMs)} ms.`,
            );
          }
          return executionResult(0);
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
          if (capturesFigures) {
            try {
              await captureFigures();
            } catch {
              // Preserve the original execution failure; figure capture is best-effort here.
            }
          }
          return executionResult(1);
        } finally {
          unsubscribe();
          if (timer !== undefined) clearTimeout(timer);
          for (const name of temporaryGlobals) {
            try {
              pyodide.globals.delete(name);
            } catch {
              // User code may already have removed a temporary global; cleanup must not mask output.
            }
          }
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
  const defaultPackages = validatedDefaultPackages(options.defaultPackages);
  return createLazyBrowserRuntime({
    kind: 'pyodide',
    moduleSpecifier: PYODIDE_MODULE_SPECIFIER,
    ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
    createBackend:
      options.createBackend ??
      createPyodideBackend(
        options.indexURL,
        defaultPackages,
        options.createInterruptBuffer ?? defaultInterruptBuffer,
      ),
  });
}
