import type { Brand } from '@loom/types';

/** A normalized, slash-separated path relative to a workspace root. */
export type WorkspacePath = Brand<string, 'WorkspacePath'>;

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;

export function isWorkspacePath(value: string): value is WorkspacePath {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return false;
  }

  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function workspacePath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) {
    throw new TypeError(
      `Invalid workspace path "${value}". Expected a normalized, slash-separated relative path.`,
    );
  }
  return value;
}
