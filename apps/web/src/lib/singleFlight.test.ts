import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from './singleFlight';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// This is the mechanism behind BUILD.md Phase 1's "Watch": N requests
// failing with 401 at the same moment must trigger exactly one refresh
// call, with every caller awaiting that same in-flight promise.
describe('createSingleFlight', () => {
  it('collapses N concurrent callers into exactly one underlying call', async () => {
    const gate = deferred<string>();
    const underlying = vi.fn(() => gate.promise);
    const run = createSingleFlight(underlying);

    const callers = [run(), run(), run(), run(), run()];
    expect(underlying).toHaveBeenCalledTimes(1);

    gate.resolve('new-access-token');
    const results = await Promise.all(callers);

    expect(results).toEqual(Array(5).fill('new-access-token'));
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh call once the previous one has settled', async () => {
    const underlying = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const run = createSingleFlight(underlying);

    await expect(run()).resolves.toBe('first');
    await expect(run()).resolves.toBe('second');
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it('propagates rejection to every concurrent caller and allows retrying afterwards', async () => {
    const gate = deferred<string>();
    const underlying = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce('ok');
    const run = createSingleFlight(underlying);

    const callers = [run(), run(), run()];
    gate.reject(new Error('refresh failed'));

    await Promise.all(
      callers.map(async (call) => {
        await expect(call).rejects.toThrow('refresh failed');
      }),
    );
    expect(underlying).toHaveBeenCalledTimes(1);

    await expect(run()).resolves.toBe('ok');
    expect(underlying).toHaveBeenCalledTimes(2);
  });
});
