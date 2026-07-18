import type {
  BrowserExecutionBackend,
  BrowserExecutionBackendFactory,
  BrowserExecutionContext,
  BrowserExecutionKind,
  BrowserExecutionRequest,
  BrowserExecutionResult,
  BrowserExecutionRuntime,
  BrowserRuntimeModuleLoader,
} from './contracts.js';
import { BrowserExecutionError } from './errors.js';
import { copyRequest, copyResult } from './validation.js';

const defaultModuleLoader: BrowserRuntimeModuleLoader = async (specifier) => import(specifier);

export interface CreateLazyBrowserRuntimeOptions {
  readonly kind: BrowserExecutionKind;
  readonly moduleSpecifier: string;
  readonly loadModule?: BrowserRuntimeModuleLoader;
  readonly createBackend: BrowserExecutionBackendFactory;
}

export function createLazyBrowserRuntime(
  options: CreateLazyBrowserRuntimeOptions,
): BrowserExecutionRuntime {
  let disposed = false;
  let backendPromise: Promise<BrowserExecutionBackend> | undefined;
  let executionTail = Promise.resolve();

  const backend = (): Promise<BrowserExecutionBackend> => {
    if (disposed) {
      return Promise.reject(
        new BrowserExecutionError('DISPOSED', `${options.kind} runtime is disposed.`),
      );
    }
    backendPromise ??= (options.loadModule ?? defaultModuleLoader)(options.moduleSpecifier)
      .then((module) => options.createBackend(module))
      .catch((error: unknown) => {
        backendPromise = undefined;
        throw error instanceof BrowserExecutionError
          ? error
          : new BrowserExecutionError(
              'RUNTIME_LOAD_FAILED',
              `Unable to load the optional ${options.kind} runtime.`,
              { cause: error },
            );
      });
    return backendPromise;
  };

  const serialize = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = executionTail.then(operation, operation);
    executionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return Object.freeze({
    kind: options.kind,
    async execute(request: BrowserExecutionRequest, context: BrowserExecutionContext = {}) {
      const snapshot = copyRequest(request);
      context.signal?.throwIfCancelled();
      return await serialize(async (): Promise<BrowserExecutionResult> => {
        if (disposed) {
          throw new BrowserExecutionError('DISPOSED', `${options.kind} runtime is disposed.`);
        }
        context.signal?.throwIfCancelled();
        const implementation = await backend();
        context.signal?.throwIfCancelled();
        return copyResult(await implementation.execute(snapshot, context));
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await executionTail;
      const implementation = await backendPromise;
      await implementation?.dispose();
    },
  });
}
