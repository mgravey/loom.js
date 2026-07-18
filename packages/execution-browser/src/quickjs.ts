import type {
  BrowserExecutionBackend,
  BrowserExecutionBackendFactory,
  BrowserExecutionContext,
  BrowserExecutionProject,
  BrowserExecutionRequest,
  BrowserRuntimeModuleLoader,
} from './contracts.js';
import { BrowserExecutionError } from './errors.js';
import { createLazyBrowserRuntime } from './lazy-runtime.js';
import { copyProject, emitOutput, executionPath } from './validation.js';

const QUICKJS_MODULE_SPECIFIER = 'quickjs-emscripten';
const QUICKJS_COMMANDS = new Set(['qjs', 'quickjs']);

interface QuickJsHandle {
  dispose(): void;
}

interface QuickJsEvalResult {
  readonly error?: QuickJsHandle;
  readonly value?: QuickJsHandle;
}

interface QuickJsContext {
  readonly global: QuickJsHandle;
  readonly undefined: QuickJsHandle;
  newObject(): QuickJsHandle;
  newString(value: string): QuickJsHandle;
  newFunction(name: string, callback: (...values: QuickJsHandle[]) => QuickJsHandle): QuickJsHandle;
  setProp(target: QuickJsHandle, key: string, value: QuickJsHandle): void;
  dump(value: QuickJsHandle): unknown;
  evalCode(source: string, filename?: string): QuickJsEvalResult;
  dispose(): void;
}

interface QuickJsRuntime {
  newContext(): QuickJsContext;
  setInterruptHandler(handler: () => boolean): void;
  dispose(): void;
}

interface QuickJsModule {
  newRuntime(): QuickJsRuntime;
}

interface QuickJsPackageModule {
  getQuickJS(): Promise<QuickJsModule>;
}

export interface CreateQuickJsExecutionRuntimeOptions {
  readonly loadModule?: BrowserRuntimeModuleLoader;
  /** Test/custom-build seam. Production callers normally use `quickjs-emscripten`. */
  readonly createBackend?: BrowserExecutionBackendFactory;
}

function assertQuickJsModule(value: unknown): asserts value is QuickJsPackageModule {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('getQuickJS' in value) ||
    typeof value.getQuickJS !== 'function'
  ) {
    throw new BrowserExecutionError(
      'RUNTIME_LOAD_FAILED',
      'quickjs-emscripten did not expose getQuickJS().',
    );
  }
}

function textFile(project: BrowserExecutionProject, path: string): string {
  const file = project.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      `QuickJS entrypoint '${path}' was not found.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.data);
  } catch (error) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      `QuickJS entrypoint '${path}' is not valid UTF-8 text.`,
      { cause: error },
    );
  }
}

function displayed(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  if (typeof value === 'function') return '[function]';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable value]';
  }
}

function installConsole(vm: QuickJsContext, context: BrowserExecutionContext): void {
  const consoleObject = vm.newObject();
  try {
    for (const [method, channel] of [
      ['log', 'stdout'],
      ['info', 'stdout'],
      ['warn', 'stderr'],
      ['error', 'stderr'],
    ] as const) {
      const callback = vm.newFunction(method, (...values) => {
        emitOutput(
          context,
          channel,
          `${values.map((value) => displayed(vm.dump(value))).join(' ')}\n`,
        );
        return vm.undefined;
      });
      try {
        vm.setProp(consoleObject, method, callback);
      } finally {
        callback.dispose();
      }
    }
    vm.setProp(vm.global, 'console', consoleObject);
  } finally {
    consoleObject.dispose();
  }
}

function installFilesystem(
  vm: QuickJsContext,
  files: Map<string, Uint8Array>,
  directories: Set<string>,
): void {
  const loom = vm.newObject();
  try {
    const readFile = vm.newFunction('readFile', (pathHandle) => {
      const path = executionPath(vm.dump(pathHandle));
      const data = files.get(path);
      if (data === undefined) throw new Error(`File '${path}' was not found.`);
      return vm.newString(new TextDecoder().decode(data));
    });
    const writeFile = vm.newFunction('writeFile', (pathHandle, contentHandle) => {
      const path = executionPath(vm.dump(pathHandle));
      const content = vm.dump(contentHandle);
      if (typeof content !== 'string') throw new TypeError('writeFile content must be a string.');
      files.set(path, new TextEncoder().encode(content));
      const segments = path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join('/'));
      }
      return vm.undefined;
    });
    try {
      vm.setProp(loom, 'readFile', readFile);
      vm.setProp(loom, 'writeFile', writeFile);
      vm.setProp(vm.global, 'loom', loom);
    } finally {
      readFile.dispose();
      writeFile.dispose();
    }
  } finally {
    loom.dispose();
  }
}

function resultingProject(
  files: ReadonlyMap<string, Uint8Array>,
  directories: ReadonlySet<string>,
): BrowserExecutionProject {
  return copyProject({
    directories: [...directories],
    files: [...files].map(([path, data]) => ({ path, data })),
  });
}

async function createQuickJsBackend(module: unknown): Promise<BrowserExecutionBackend> {
  assertQuickJsModule(module);
  const quickjs = await module.getQuickJS();
  return Object.freeze({
    async execute(request: BrowserExecutionRequest, context: BrowserExecutionContext) {
      await Promise.resolve();
      if (!QUICKJS_COMMANDS.has(request.command)) {
        throw new BrowserExecutionError(
          'UNSUPPORTED_COMMAND',
          "QuickJS accepts only the 'qjs' or 'quickjs' command.",
        );
      }
      const [entrypoint, ...scriptArguments] = request.arguments ?? [];
      if (entrypoint === undefined) {
        throw new BrowserExecutionError(
          'INVALID_REQUEST',
          'QuickJS requires an entrypoint argument.',
        );
      }
      const normalizedEntrypoint = executionPath(
        request.workingDirectory === undefined || request.workingDirectory.length === 0
          ? entrypoint
          : `${request.workingDirectory}/${entrypoint}`,
      );
      const source = textFile(request.project, normalizedEntrypoint);
      const files = new Map(
        request.project.files.map((file) => [file.path, new Uint8Array(file.data)] as const),
      );
      const directories = new Set(request.project.directories ?? []);
      const runtime = quickjs.newRuntime();
      const deadline = request.timeoutMs === undefined ? undefined : Date.now() + request.timeoutMs;
      const executionState = { timedOut: false };
      runtime.setInterruptHandler(() => {
        executionState.timedOut = deadline !== undefined && Date.now() >= deadline;
        return executionState.timedOut || context.signal?.cancelled === true;
      });
      const vm = runtime.newContext();
      try {
        installConsole(vm, context);
        installFilesystem(vm, files, directories);
        const prelude = `globalThis.process = Object.freeze({ argv: ${JSON.stringify([
          request.command,
          entrypoint,
          ...scriptArguments,
        ])} });\n`;
        const result = vm.evalCode(`${prelude}${source}`, normalizedEntrypoint);
        if (result.error !== undefined) {
          const error = displayed(vm.dump(result.error));
          result.error.dispose();
          if (context.signal?.cancelled === true) context.signal.throwIfCancelled();
          if (executionState.timedOut) {
            throw new BrowserExecutionError(
              'TIMED_OUT',
              `QuickJS execution exceeded ${String(request.timeoutMs)} ms.`,
            );
          }
          emitOutput(context, 'stderr', `${error}\n`);
          return Object.freeze({ exitCode: 1, project: resultingProject(files, directories) });
        }
        result.value?.dispose();
        context.signal?.throwIfCancelled();
        return Object.freeze({ exitCode: 0, project: resultingProject(files, directories) });
      } finally {
        vm.dispose();
        runtime.dispose();
      }
    },
    dispose: () => undefined,
  });
}

export function createQuickJsExecutionRuntime(options: CreateQuickJsExecutionRuntimeOptions = {}) {
  return createLazyBrowserRuntime({
    kind: 'quickjs',
    moduleSpecifier: QUICKJS_MODULE_SPECIFIER,
    ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
    createBackend: options.createBackend ?? createQuickJsBackend,
  });
}
