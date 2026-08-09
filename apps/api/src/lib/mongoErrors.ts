/** True for a MongoDB duplicate-key error (E11000) from a unique index —
 * used to turn a lost race on an `insert` into a 409/idempotent response
 * instead of a 500. */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}
