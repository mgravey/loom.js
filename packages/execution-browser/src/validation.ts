import type {
  BrowserExecutionContext,
  BrowserExecutionFile,
  BrowserExecutionProject,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from './contracts.js';
import { BrowserExecutionError } from './errors.js';

const MAXIMUM_PATH_LENGTH = 4096;
const MAXIMUM_COMMAND_LENGTH = 1024;
const MAXIMUM_ARGUMENT_LENGTH = 1024 * 1024;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function executionPath(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > MAXIMUM_PATH_LENGTH) {
    throw new BrowserExecutionError('INVALID_PROJECT', 'Execution paths must be bounded strings.');
  }
  if (allowEmpty && value.length === 0) return value;
  const segments = value.split('/');
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      `Execution path '${value}' must be a normalized relative POSIX path.`,
    );
  }
  return value;
}

function copyFile(value: unknown): BrowserExecutionFile {
  if (
    !record(value) ||
    !exactKeys(value, ['path', 'data']) ||
    typeof value.path !== 'string' ||
    !(value.data instanceof Uint8Array)
  ) {
    throw new BrowserExecutionError('INVALID_PROJECT', 'Execution files require path and bytes.');
  }
  return Object.freeze({ path: executionPath(value.path), data: new Uint8Array(value.data) });
}

export function copyProject(value: unknown): BrowserExecutionProject {
  if (
    !record(value) ||
    !exactKeys(value, ['directories', 'files']) ||
    !Array.isArray(value.files) ||
    (value.directories !== undefined && !Array.isArray(value.directories))
  ) {
    throw new BrowserExecutionError(
      'INVALID_PROJECT',
      'An execution project snapshot is required.',
    );
  }
  const directories = (value.directories ?? []).map((path) => executionPath(path));
  const files = value.files.map((file) => copyFile(file));
  const directorySet = new Set<string>();
  const fileSet = new Set<string>();
  for (const directory of directories) {
    if (directorySet.has(directory)) {
      throw new BrowserExecutionError('INVALID_PROJECT', `Duplicate directory '${directory}'.`);
    }
    directorySet.add(directory);
  }
  for (const file of files) {
    if (fileSet.has(file.path) || directorySet.has(file.path)) {
      throw new BrowserExecutionError(
        'INVALID_PROJECT',
        `Conflicting project path '${file.path}'.`,
      );
    }
    fileSet.add(file.path);
  }
  for (const file of files) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (fileSet.has(segments.slice(0, index).join('/'))) {
        throw new BrowserExecutionError(
          'INVALID_PROJECT',
          `File '${file.path}' is nested below another file.`,
        );
      }
    }
  }
  for (const directory of directories) {
    const segments = directory.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (fileSet.has(segments.slice(0, index).join('/'))) {
        throw new BrowserExecutionError(
          'INVALID_PROJECT',
          `Directory '${directory}' is nested below a file.`,
        );
      }
    }
  }
  directories.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files),
  });
}

export function copyRequest(value: unknown): BrowserExecutionRequest {
  if (
    !record(value) ||
    !exactKeys(value, ['command', 'arguments', 'workingDirectory', 'timeoutMs', 'project']) ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    value.command.length > MAXIMUM_COMMAND_LENGTH ||
    (value.arguments !== undefined && !Array.isArray(value.arguments)) ||
    (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string') ||
    (value.timeoutMs !== undefined &&
      (typeof value.timeoutMs !== 'number' ||
        !Number.isSafeInteger(value.timeoutMs) ||
        value.timeoutMs <= 0))
  ) {
    throw new BrowserExecutionError('INVALID_REQUEST', 'Invalid browser execution request.');
  }
  const arguments_ = (value.arguments ?? []).map((argument) => {
    if (typeof argument !== 'string' || argument.length > MAXIMUM_ARGUMENT_LENGTH) {
      throw new BrowserExecutionError('INVALID_REQUEST', 'Execution arguments must be strings.');
    }
    return argument;
  });
  const workingDirectory =
    value.workingDirectory === undefined ? undefined : executionPath(value.workingDirectory, true);
  const timeoutMs = value.timeoutMs;
  return Object.freeze({
    command: value.command,
    arguments: Object.freeze(arguments_),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    project: copyProject(value.project),
  });
}

export function copyResult(value: BrowserExecutionResult): BrowserExecutionResult {
  if (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) {
    throw new BrowserExecutionError('EXECUTION_FAILED', 'Runtime returned an invalid exit code.');
  }
  const project = copyProject(value.project);
  const projectFiles = new Set(project.files.map((file) => file.path));
  const artifacts = (value.artifacts ?? []).map((artifact) => {
    if (
      !record(artifact) ||
      !exactKeys(artifact, ['path', 'mediaType']) ||
      typeof artifact.mediaType !== 'string' ||
      artifact.mediaType.length === 0 ||
      artifact.mediaType.length > 256
    ) {
      throw new BrowserExecutionError('EXECUTION_FAILED', 'Runtime returned an invalid artifact.');
    }
    const path = executionPath(artifact.path);
    if (!projectFiles.has(path)) {
      throw new BrowserExecutionError(
        'EXECUTION_FAILED',
        `Runtime artifact '${path}' is not present in the resulting project.`,
      );
    }
    return Object.freeze({ path, mediaType: artifact.mediaType });
  });
  return Object.freeze({
    exitCode: value.exitCode,
    project,
    ...(artifacts.length === 0 ? {} : { artifacts: Object.freeze(artifacts) }),
  });
}

export function emitOutput(
  context: BrowserExecutionContext,
  channel: 'stdout' | 'stderr',
  chunk: string,
): void {
  try {
    context.onOutput?.(Object.freeze({ channel, chunk }));
  } catch {
    // Host diagnostics must not alter execution or cleanup behavior.
  }
}

export function cancellationError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new BrowserExecutionError('EXECUTION_FAILED', 'Browser execution was cancelled.', {
        cause: reason,
      });
}
