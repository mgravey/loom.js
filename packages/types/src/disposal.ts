export type Awaitable<Value> = Value | PromiseLike<Value>;

/** Loom-owned disposal protocol; independent of host language disposal symbols. */
export interface Disposable {
  dispose(): Awaitable<void>;
}

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}
