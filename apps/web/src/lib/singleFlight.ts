/**
 * Wraps an async function so concurrent callers share one in-flight call
 * instead of each triggering their own. This is what keeps N requests
 * failing with 401 at once from firing N separate token refreshes — see
 * BUILD.md Phase 1, "Watch".
 */
export function createSingleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return function run(): Promise<T> {
    inFlight ??= fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
