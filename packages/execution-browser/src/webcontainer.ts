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

const WEBCONTAINER_MODULE_SPECIFIER = '@webcontainer/api';

interface WebContainerProcess {
  readonly output: ReadableStream<string>;
  readonly exit: Promise<number>;
  kill(): void;
}

interface WebContainerFileSystem {
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void>;
}

interface WebContainerInstance {
  readonly fs: WebContainerFileSystem;
  mount(tree: WebContainerTree, options?: { readonly mountPoint?: string }): Promise<void>;
  spawn(
    command: string,
    arguments_: readonly string[],
    options?: { readonly cwd?: string; readonly output?: boolean },
  ): Promise<WebContainerProcess>;
  export(path: string, options: { readonly format: 'json' }): Promise<WebContainerTree>;
  teardown(): void;
}

interface WebContainerPackageModule {
  readonly WebContainer: {
    boot(options?: {
      readonly coep?: 'require-corp' | 'credentialless' | 'none';
    }): Promise<WebContainerInstance>;
  };
}

interface WebContainerFileNode {
  readonly file: { readonly contents: string | Uint8Array };
}

interface WebContainerDirectoryNode {
  readonly directory: WebContainerTree;
}

type WebContainerNode = WebContainerFileNode | WebContainerDirectoryNode;
type WebContainerTree = Readonly<Record<string, WebContainerNode>>;

export interface CreateWebContainerExecutionRuntimeOptions {
  readonly loadModule?: BrowserRuntimeModuleLoader;
  readonly createBackend?: BrowserExecutionBackendFactory;
  readonly coep?: 'require-corp' | 'credentialless' | 'none';
}

function treeDirectory(
  tree: Record<string, WebContainerNode>,
  path: string,
): Record<string, WebContainerNode> {
  let current = tree;
  for (const segment of path.split('/')) {
    const node = current[segment];
    if (node === undefined) {
      const directory: Record<string, WebContainerNode> = {};
      current[segment] = { directory };
      current = directory;
    } else if ('directory' in node) {
      current = node.directory;
    } else {
      throw new BrowserExecutionError(
        'INVALID_PROJECT',
        `Project path '${path}' conflicts with a file.`,
      );
    }
  }
  return current;
}

function projectTree(project: BrowserExecutionProject): WebContainerTree {
  const root: Record<string, WebContainerNode> = {};
  for (const directory of project.directories ?? []) treeDirectory(root, directory);
  for (const file of project.files) {
    const separator = file.path.lastIndexOf('/');
    const parent = separator < 0 ? root : treeDirectory(root, file.path.slice(0, separator));
    const name = separator < 0 ? file.path : file.path.slice(separator + 1);
    parent[name] = { file: { contents: new Uint8Array(file.data) } };
  }
  return root;
}

function treeProject(tree: WebContainerTree): BrowserExecutionProject {
  const directories: string[] = [];
  const files: { path: string; data: Uint8Array }[] = [];
  const visit = (current: WebContainerTree, parent: string): void => {
    for (const name of Object.keys(current).sort((left, right) => left.localeCompare(right))) {
      const node = current[name];
      if (node === undefined) continue;
      const path = parent.length === 0 ? name : `${parent}/${name}`;
      executionPath(path);
      if ('directory' in node) {
        directories.push(path);
        visit(node.directory, path);
      } else {
        files.push({
          path,
          data:
            typeof node.file.contents === 'string'
              ? new TextEncoder().encode(node.file.contents)
              : new Uint8Array(node.file.contents),
        });
      }
    }
  };
  visit(tree, '');
  return copyProject({ directories, files });
}

function assertModule(value: unknown): asserts value is WebContainerPackageModule {
  const candidate = value as {
    readonly WebContainer?: { readonly boot?: unknown };
  };
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof candidate.WebContainer !== 'object' ||
    typeof candidate.WebContainer.boot !== 'function'
  ) {
    throw new BrowserExecutionError(
      'RUNTIME_LOAD_FAILED',
      '@webcontainer/api did not expose WebContainer.boot().',
    );
  }
}

function createWebContainerBackend(
  coep: 'require-corp' | 'credentialless' | 'none' | undefined,
): BrowserExecutionBackendFactory {
  return async (module) => {
    assertModule(module);
    const instance = await module.WebContainer.boot(coep === undefined ? {} : { coep });
    let sequence = 0;
    return Object.freeze({
      async execute(request: BrowserExecutionRequest, context: BrowserExecutionContext) {
        sequence += 1;
        const root = `.loom-runs/run-${String(sequence)}`;
        await instance.fs.mkdir(root, { recursive: true });
        await instance.mount(projectTree(request.project), { mountPoint: root });
        const cwd =
          request.workingDirectory === undefined || request.workingDirectory.length === 0
            ? root
            : `${root}/${request.workingDirectory}`;
        let process: WebContainerProcess | undefined;
        let unsubscribe = (): void => undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const executionState = { timedOut: false };
        try {
          context.signal?.throwIfCancelled();
          process = await instance.spawn(request.command, request.arguments ?? [], {
            cwd,
            output: true,
          });
          unsubscribe =
            context.signal?.onCancel(() => {
              process?.kill();
            }) ?? unsubscribe;
          if (request.timeoutMs !== undefined) {
            timer = setTimeout(() => {
              executionState.timedOut = true;
              process?.kill();
            }, request.timeoutMs);
          }
          const output = process.output.pipeTo(
            new WritableStream<string>({
              write(chunk) {
                emitOutput(context, 'stdout', chunk);
              },
            }),
          );
          const exitCode = await process.exit;
          await output;
          if (context.signal?.cancelled === true) {
            throw cancellationError(context.signal.reason);
          }
          if (executionState.timedOut) {
            throw new BrowserExecutionError(
              'TIMED_OUT',
              `WebContainer execution exceeded ${String(request.timeoutMs)} ms.`,
            );
          }
          const exported = await instance.export(root, { format: 'json' });
          return Object.freeze({ exitCode, project: treeProject(exported) });
        } catch (error) {
          if (error instanceof BrowserExecutionError) throw error;
          throw new BrowserExecutionError('EXECUTION_FAILED', 'WebContainer execution failed.', {
            cause: error,
          });
        } finally {
          unsubscribe();
          if (timer !== undefined) clearTimeout(timer);
          await instance.fs.rm(root, { recursive: true, force: true });
        }
      },
      dispose() {
        instance.teardown();
      },
    });
  };
}

export function createWebContainerExecutionRuntime(
  options: CreateWebContainerExecutionRuntimeOptions = {},
) {
  return createLazyBrowserRuntime({
    kind: 'webcontainer',
    moduleSpecifier: WEBCONTAINER_MODULE_SPECIFIER,
    ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
    createBackend: options.createBackend ?? createWebContainerBackend(options.coep),
  });
}
