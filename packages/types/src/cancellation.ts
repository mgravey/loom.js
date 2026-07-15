export interface CancellationSignal {
  readonly cancelled: boolean;
  readonly reason: unknown;
  throwIfCancelled(): void;
  onCancel(listener: (reason: unknown) => void): () => void;
}

export interface CancellationSource {
  readonly signal: CancellationSignal;
  cancel(reason?: unknown): void;
}

export class CancellationError extends Error {
  public readonly reason: unknown;

  public constructor(reason?: unknown) {
    super('Operation cancelled', { cause: reason });
    this.name = 'CancellationError';
    this.reason = reason;
  }
}

export function createCancellationSource(): CancellationSource {
  let cancelled = false;
  let reason: unknown;
  const listeners = new Set<(cancelReason: unknown) => void>();

  const signal: CancellationSignal = {
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return reason;
    },
    throwIfCancelled() {
      if (cancelled) {
        throw new CancellationError(reason);
      }
    },
    onCancel(listener) {
      if (cancelled) {
        listener(reason);
        return () => undefined;
      }
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (subscribed) {
          subscribed = false;
          listeners.delete(listener);
        }
      };
    },
  };

  return {
    signal,
    cancel(cancelReason = new CancellationError()) {
      if (cancelled) return;
      cancelled = true;
      reason = cancelReason;
      const snapshot = [...listeners];
      listeners.clear();
      for (const listener of snapshot) listener(reason);
    },
  };
}
