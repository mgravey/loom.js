import { LoomAggregateError, LoomError, type LoomErrorCode } from '@mgravey/loom-types';

export type CoreErrorCode =
  | 'CAPABILITY_DUPLICATE'
  | 'CAPABILITY_MISSING'
  | 'REGISTRATION_FROZEN'
  | 'SERVICE_DUPLICATE'
  | 'SERVICE_MISSING'
  | 'SERVICE_CYCLE'
  | 'SERVICE_SESSION_SCOPE_REQUIRED'
  | 'SCOPE_DISPOSED'
  | 'CONFIGURATION_INVALID'
  | 'CONFIGURATION_UNKNOWN_PLUGIN'
  | 'DISPOSAL_FAILED';

const PUBLIC_CODES: Readonly<Record<CoreErrorCode, LoomErrorCode>> = Object.freeze({
  CAPABILITY_DUPLICATE: 'DUPLICATE_CAPABILITY',
  CAPABILITY_MISSING: 'MISSING_CAPABILITY',
  REGISTRATION_FROZEN: 'REGISTRATION_CLOSED',
  SERVICE_DUPLICATE: 'DUPLICATE_SERVICE',
  SERVICE_MISSING: 'MISSING_SERVICE',
  SERVICE_CYCLE: 'CIRCULAR_SERVICE_DEPENDENCY',
  SERVICE_SESSION_SCOPE_REQUIRED: 'INVALID_LIFECYCLE_TRANSITION',
  SCOPE_DISPOSED: 'INVALID_LIFECYCLE_TRANSITION',
  CONFIGURATION_INVALID: 'INVALID_CONFIGURATION',
  CONFIGURATION_UNKNOWN_PLUGIN: 'INVALID_CONFIGURATION',
  DISPOSAL_FAILED: 'CLEANUP_FAILED',
});

/** Base error for failures produced by Loom Core's foundational services. */
export class CoreError extends LoomError {
  constructor(
    code: CoreErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(PUBLIC_CODES[code], message, { cause: options?.cause, details });
    this.name = 'CoreError';
  }
}

export class AggregateDisposalError extends LoomAggregateError {
  constructor(errors: readonly unknown[]) {
    super(
      'CLEANUP_FAILED',
      `Disposal completed with ${String(errors.length)} failure${errors.length === 1 ? '' : 's'}.`,
      errors,
    );
    this.name = 'AggregateDisposalError';
  }
}
