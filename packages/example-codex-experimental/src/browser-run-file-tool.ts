import type { CodexTool } from '@mgravey/loom-agent-codex';
import {
  executeBrowserWorkspace,
  type BrowserExecutionProject,
  type BrowserExecutionRuntime,
  type BrowserExecutionWorkspace,
} from '@mgravey/loom-execution-browser';
import {
  importWorkspaceEntries,
  snapshotWorkspace,
  workspacePath,
  type ProjectWorkspace,
  type WorkspaceImportEntry,
} from '@mgravey/loom-tool-workspace';
import type { JsonObject } from '@mgravey/loom-types';

type CodexToolExecutionContext = Parameters<CodexTool['execute']>[1];

export const BROWSER_RUN_FILE_OPERATION = 'website/run-workspace-file';
export const BROWSER_INSTALL_PACKAGES_OPERATION = 'website/install-runtime-packages';

export type WebsiteRuntimeId = 'quickjs' | 'node' | 'python';

export interface CreateBrowserRunFileToolOptions {
  readonly workspace: ProjectWorkspace;
  readonly runtimes: Readonly<Record<WebsiteRuntimeId, BrowserExecutionRuntime>>;
  /** Defaults to true. False executes against a snapshot and discards filesystem changes. */
  readonly writeBack?: boolean;
  readonly authorizeWriteBack?: () => boolean | Promise<boolean>;
  readonly persist?: () => Promise<void>;
  readonly maxOutputCharacters?: number;
}

interface RunFileInput {
  readonly runtime: WebsiteRuntimeId;
  readonly path: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
}

interface InstallPackagesInput {
  readonly runtime: 'node' | 'python';
  readonly packages: readonly string[];
  readonly timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 64 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function excludedRuntimePath(path: string): boolean {
  if (path === '.loom/conversations' || path.startsWith('.loom/conversations/')) return true;
  return path
    .split('/')
    .some((segment) =>
      ['node_modules', '.venv', '__pycache__', '.pytest_cache', '.cache'].includes(segment),
    );
}

export function createBrowserExecutionWorkspace(
  workspace: ProjectWorkspace,
  options: { readonly writeBack?: boolean } = {},
): BrowserExecutionWorkspace {
  return Object.freeze({
    async load() {
      const entries = await snapshotWorkspace(workspace);
      return Object.freeze({
        directories: entries
          .filter((entry) => entry.kind === 'directory' && !excludedRuntimePath(entry.path))
          .map((entry) => entry.path),
        files: entries.flatMap((entry) =>
          entry.kind === 'file' && !excludedRuntimePath(entry.path)
            ? [{ path: entry.path, data: entry.content }]
            : [],
        ),
      });
    },
    async commit(project: BrowserExecutionProject) {
      if (options.writeBack === false) return;
      const desiredDirectories = new Set(
        (project.directories ?? []).filter((path) => !excludedRuntimePath(path)),
      );
      const desiredFiles = new Map(
        project.files
          .filter((file) => !excludedRuntimePath(file.path))
          .map((file) => [file.path, file.data] as const),
      );
      const current = await snapshotWorkspace(workspace);
      for (const entry of [...current].sort(
        (left, right) => right.path.length - left.path.length,
      )) {
        const keep =
          entry.kind === 'directory'
            ? desiredDirectories.has(entry.path)
            : desiredFiles.has(entry.path);
        if (!keep && !excludedRuntimePath(entry.path)) {
          await workspace.remove(
            entry.path,
            entry.kind === 'directory' ? { recursive: true } : undefined,
          );
        }
      }
      const entries: WorkspaceImportEntry[] = [
        ...[...desiredDirectories].map((path) => ({ path, kind: 'directory' as const })),
        ...[...desiredFiles].map(([path, content]) => ({
          path,
          kind: 'file' as const,
          content,
        })),
      ];
      await importWorkspaceEntries(workspace, entries, { overwrite: true });
    },
  });
}

function validatedInput(value: JsonObject): RunFileInput {
  if (!isRecord(value)) throw new TypeError('Run-file input must be an object.');
  for (const key of Object.keys(value)) {
    if (!['runtime', 'path', 'arguments', 'timeoutMs'].includes(key)) {
      throw new TypeError(`Run-file input contains unsupported property '${key}'.`);
    }
  }
  if (value.runtime !== 'quickjs' && value.runtime !== 'node' && value.runtime !== 'python') {
    throw new TypeError("Run-file runtime must be 'quickjs', 'node', or 'python'.");
  }
  if (typeof value.path !== 'string' || value.path.trim() === '' || value.path.length > 1024) {
    throw new TypeError('Run-file path must be a non-empty bounded string.');
  }
  const path = workspacePath(value.path);
  const arguments_ = value.arguments ?? [];
  if (
    !Array.isArray(arguments_) ||
    arguments_.length > 64 ||
    arguments_.some((argument) => typeof argument !== 'string' || argument.length > 4096)
  ) {
    throw new TypeError('Run-file arguments must be at most 64 bounded strings.');
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(`Run-file timeoutMs must be between 1 and ${String(MAX_TIMEOUT_MS)}.`);
  }
  const validatedArguments: string[] = [];
  for (const argument of arguments_ as readonly unknown[]) {
    if (typeof argument === 'string') validatedArguments.push(argument);
  }
  return Object.freeze({
    runtime: value.runtime,
    path,
    arguments: Object.freeze(validatedArguments),
    timeoutMs,
  });
}

function runtimeCommand(runtime: WebsiteRuntimeId): string {
  if (runtime === 'python') return 'python';
  if (runtime === 'node') return 'node';
  return 'quickjs';
}

function validPackageRequirement(runtime: 'node' | 'python', requirement: string): boolean {
  if (
    requirement.length === 0 ||
    requirement.length > 256 ||
    requirement.startsWith('-') ||
    /[\s\0]/u.test(requirement)
  ) {
    return false;
  }
  if (runtime === 'python') {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[a-zA-Z0-9_,.-]+\])?(?:(?:==|>=|<=|~=|!=|>|<)[a-zA-Z0-9.*+!_-]+)?$/u.test(
      requirement,
    );
  }
  return /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9.^~*+_-]+)?$/u.test(
    requirement,
  );
}

function validatedInstallInput(value: JsonObject): InstallPackagesInput {
  for (const key of Object.keys(value)) {
    if (!['runtime', 'packages', 'timeoutMs'].includes(key)) {
      throw new TypeError(`Package-install input contains unsupported property '${key}'.`);
    }
  }
  if (value.runtime !== 'node' && value.runtime !== 'python') {
    throw new TypeError("Package-install runtime must be 'node' or 'python'.");
  }
  const runtime = value.runtime;
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > 32 ||
    value.packages.some(
      (requirement) =>
        typeof requirement !== 'string' || !validPackageRequirement(runtime, requirement),
    )
  ) {
    throw new TypeError(
      'Package-install packages must contain 1 to 32 registry package requirements.',
    );
  }
  const timeoutMs = value.timeoutMs ?? MAX_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Package-install timeoutMs must be between 1 and ${String(MAX_TIMEOUT_MS)}.`,
    );
  }
  const packages: string[] = [];
  for (const packageName of value.packages as readonly unknown[]) {
    if (typeof packageName === 'string') packages.push(packageName);
  }
  return Object.freeze({
    runtime,
    packages: Object.freeze(packages),
    timeoutMs,
  });
}

function outputCollector(limit: number): {
  append(channel: 'stdout' | 'stderr', chunk: string): void;
  value(channel: 'stdout' | 'stderr'): string;
} {
  const output = { stdout: '', stderr: '' };
  const truncated = { stdout: false, stderr: false };
  return {
    append(channel, chunk) {
      const remaining = Math.max(0, limit - output[channel].length);
      output[channel] += chunk.slice(0, remaining);
      if (chunk.length > remaining) truncated[channel] = true;
    },
    value(channel) {
      return `${output[channel]}${truncated[channel] ? '\n[output truncated]' : ''}`;
    },
  };
}

export function createBrowserRunFileTool(options: CreateBrowserRunFileToolOptions): CodexTool {
  const maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters <= 0) {
    throw new TypeError('Run-file maxOutputCharacters must be a positive integer.');
  }
  return Object.freeze({
    name: 'run_workspace_file',
    operation: BROWSER_RUN_FILE_OPERATION,
    description:
      'Execute a workspace entrypoint in the correct isolated browser runtime and return its real exit code, stdout, and stderr, plus generated figures. Always select python for .py files: Loom automatically routes it to Pyodide, where NumPy and Matplotlib are already loaded and must not be installed again. Select quickjs for standalone JavaScript or node for Node.js projects.',
    inputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['quickjs', 'node', 'python'] },
        path: { type: 'string', description: 'Workspace-relative entrypoint path.' },
        arguments: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
      },
      required: ['runtime', 'path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string' },
        path: { type: 'string' },
        exitCode: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, mediaType: { type: 'string' } },
            required: ['path', 'mediaType'],
            additionalProperties: false,
          },
        },
      },
      required: ['runtime', 'path', 'exitCode', 'stdout', 'stderr', 'artifacts'],
      additionalProperties: false,
    },
    allowedCallers: ['direct'] as const,
    async execute(value: JsonObject, context?: CodexToolExecutionContext) {
      const input = validatedInput(value);
      if ((await options.authorizeWriteBack?.()) === false) {
        throw new Error('The user did not authorize runtime write-back to this workspace.');
      }
      const runtime = options.runtimes[input.runtime];
      const output = outputCollector(maxOutputCharacters);
      const result = await executeBrowserWorkspace(
        runtime,
        createBrowserExecutionWorkspace(
          options.workspace,
          options.writeBack === undefined ? {} : { writeBack: options.writeBack },
        ),
        {
          command: runtimeCommand(input.runtime),
          arguments: [input.path, ...input.arguments],
          timeoutMs: input.timeoutMs,
        },
        {
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
          onOutput: ({ channel, chunk }) => output.append(channel, chunk),
        },
      );
      if (options.writeBack !== false) await options.persist?.();
      return {
        runtime: input.runtime,
        path: input.path,
        exitCode: result.exitCode,
        stdout: output.value('stdout'),
        stderr: output.value('stderr'),
        artifacts:
          options.writeBack === false
            ? []
            : (result.artifacts ?? []).map((artifact) => ({
                path: artifact.path,
                mediaType: artifact.mediaType,
              })),
      };
    },
  });
}

export function createBrowserInstallPackagesTool(
  options: CreateBrowserRunFileToolOptions,
): CodexTool {
  const maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters <= 0) {
    throw new TypeError('Package-install maxOutputCharacters must be a positive integer.');
  }
  return Object.freeze({
    name: 'install_runtime_packages',
    operation: BROWSER_INSTALL_PACKAGES_OPERATION,
    description:
      'Install only additional registry packages that are not already available in the selected browser runtime. Do not install NumPy or Matplotlib: Python runs use Pyodide and include both by default. Additional Python packages use micropip and compatible wheels. Node packages use npm, record dependencies in package.json/package-lock.json, and are restored before later Node runs.',
    inputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['node', 'python'] },
        packages: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 32,
          description: 'Registry package requirements, optionally including a version constraint.',
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
      },
      required: ['runtime', 'packages'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string' },
        packages: { type: 'array', items: { type: 'string' } },
        exitCode: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['runtime', 'packages', 'exitCode', 'stdout', 'stderr'],
      additionalProperties: false,
    },
    allowedCallers: ['direct'] as const,
    async execute(value: JsonObject, context?: CodexToolExecutionContext) {
      const input = validatedInstallInput(value);
      if ((await options.authorizeWriteBack?.()) === false) {
        throw new Error('The user did not authorize package write-back to this workspace.');
      }
      const output = outputCollector(maxOutputCharacters);
      const result = await executeBrowserWorkspace(
        options.runtimes[input.runtime],
        createBrowserExecutionWorkspace(
          options.workspace,
          options.writeBack === undefined ? {} : { writeBack: options.writeBack },
        ),
        {
          command: input.runtime === 'python' ? 'micropip' : 'npm',
          arguments:
            input.runtime === 'python'
              ? input.packages
              : ['install', '--save', '--', ...input.packages],
          timeoutMs: input.timeoutMs,
        },
        {
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
          onOutput: ({ channel, chunk }) => output.append(channel, chunk),
        },
      );
      if (options.writeBack !== false) await options.persist?.();
      return {
        runtime: input.runtime,
        packages: [...input.packages],
        exitCode: result.exitCode,
        stdout: output.value('stdout'),
        stderr: output.value('stderr'),
      };
    },
  });
}
