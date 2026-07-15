export interface Clock {
  now(): number;
}

/** The default wall clock. Kept replaceable for deterministic runtimes and tests. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
});
