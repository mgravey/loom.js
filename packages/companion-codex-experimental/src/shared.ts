import type {
  CodexCompanionDiagnosticEvent,
  CodexCompanionDiagnosticSink,
  CodexCompanionRuntime,
  CodexCompanionRuntimeSource,
  CodexCompanionValueSource,
} from './contracts.js';
import { CodexCompanionError } from './errors.js';

export const LOOM_COMPANION_EXTENSION_ID = 'gdcebopdllcifgleoefgbobdopiaholg' as const;
export const CODEX_COMPANION_PROVIDER_ID = 'openai/codex-experimental' as const;
export const CODEX_MODEL_PORT_NAME = 'loom/codex-model-experimental/v1' as const;
export const CODEX_MODEL_TRANSPORT_PROTOCOL = 'loom/codex-model-experimental' as const;
export const CODEX_MODEL_TRANSPORT_VERSION = 1 as const;
export const CODEX_ORIGIN_ACCESS_PROTOCOL = 'loom/codex-origin-access-experimental' as const;
export const CODEX_ORIGIN_ACCESS_VERSION = 1 as const;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:[\]-]{1,256}$/u;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function report(
  sink: CodexCompanionDiagnosticSink | undefined,
  event: CodexCompanionDiagnosticEvent,
): void {
  try {
    sink?.(Object.freeze(event));
  } catch {
    // Diagnostics must never alter authentication, transport, or cleanup behavior.
  }
}

export function resolveIdentifier(source: CodexCompanionValueSource, label: string): string {
  let value: unknown;
  try {
    value = typeof source === 'function' ? source() : source;
  } catch {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      `Loom companion ${label} supplier failed.`,
    );
  }
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      `Loom companion ${label} must be a valid non-empty identifier.`,
    );
  }
  return value;
}

export function resolveRuntime(source: CodexCompanionRuntimeSource): CodexCompanionRuntime {
  let runtime: unknown;
  try {
    runtime = typeof source === 'function' ? source() : source;
  } catch {
    throw new CodexCompanionError(
      'EXTENSION_UNAVAILABLE',
      'The Loom.js Companion Chrome runtime is unavailable.',
    );
  }
  if (
    runtime === null ||
    (typeof runtime !== 'object' && typeof runtime !== 'function') ||
    typeof (runtime as Partial<CodexCompanionRuntime>).sendMessage !== 'function' ||
    typeof (runtime as Partial<CodexCompanionRuntime>).connect !== 'function'
  ) {
    throw new CodexCompanionError(
      'EXTENSION_UNAVAILABLE',
      'The Loom.js Companion Chrome runtime is unavailable.',
    );
  }
  return runtime as CodexCompanionRuntime;
}

export function validateRequestIdFactory(
  factory: (() => string) | undefined,
  prefix: string,
): () => string {
  if (factory !== undefined && typeof factory !== 'function') {
    throw new CodexCompanionError(
      'INVALID_CONFIGURATION',
      'Loom companion requestIdFactory must be a function.',
    );
  }
  let nextRequest = 0;
  return () => {
    nextRequest += 1;
    return resolveIdentifier(factory ?? `${prefix}-${String(nextRequest)}`, 'request ID');
  };
}
