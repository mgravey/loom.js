export type BrowserExecutionKind = 'quickjs' | 'webcontainer' | 'pyodide';
export type BrowserExecutionOutputChannel = 'stdout' | 'stderr';

export interface BrowserExecutionFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface BrowserExecutionProject {
  readonly directories?: readonly string[];
  readonly files: readonly BrowserExecutionFile[];
}

/**
 * A deliberately credential-free invocation. Runtime adapters never accept environment variables,
 * HTTP headers, cookies, fetch callbacks, or bearer values.
 */
export interface BrowserExecutionRequest {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly project: BrowserExecutionProject;
}

export interface BrowserExecutionOutput {
  readonly channel: BrowserExecutionOutputChannel;
  readonly chunk: string;
}

export interface BrowserCancellationSignal {
  readonly cancelled: boolean;
  readonly reason: unknown;
  throwIfCancelled(): void;
  onCancel(listener: (reason: unknown) => void): () => void;
}

export interface BrowserExecutionContext {
  readonly signal?: BrowserCancellationSignal;
  readonly onOutput?: (output: BrowserExecutionOutput) => void;
}

export interface BrowserExecutionResult {
  readonly exitCode: number;
  readonly project: BrowserExecutionProject;
  /** Files produced for host presentation, such as rendered figures. */
  readonly artifacts?: readonly BrowserExecutionArtifact[];
}

export interface BrowserExecutionArtifact {
  readonly path: string;
  readonly mediaType: string;
}

export interface BrowserExecutionRuntime {
  readonly kind: BrowserExecutionKind;
  execute(
    request: BrowserExecutionRequest,
    context?: BrowserExecutionContext,
  ): Promise<BrowserExecutionResult>;
  dispose(): Promise<void>;
}

export type BrowserRuntimeModuleLoader = (specifier: string) => Promise<unknown>;

export interface BrowserExecutionBackend {
  execute(
    request: BrowserExecutionRequest,
    context: BrowserExecutionContext,
  ): Promise<BrowserExecutionResult>;
  dispose(): Promise<void> | void;
}

export type BrowserExecutionBackendFactory = (
  module: unknown,
) => Promise<BrowserExecutionBackend> | BrowserExecutionBackend;

/** Adapter seam used by browser workspaces that own conflict detection and persistence. */
export interface BrowserExecutionWorkspace {
  load(context?: BrowserExecutionContext): Promise<BrowserExecutionProject>;
  commit(project: BrowserExecutionProject, context?: BrowserExecutionContext): Promise<void>;
}

export interface BrowserWorkspaceInvocation {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
}
