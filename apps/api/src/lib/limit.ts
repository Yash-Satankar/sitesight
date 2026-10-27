/**
 * Run at most `n` async tasks at once; extra calls wait in FIFO order.
 * A finishing task hands its slot straight to the next waiter, so the limit is never exceeded.
 * `createLimiter(1)` doubles as a mutex.
 */
export function createLimiter(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Concurrency limit must be a positive integer, got ${n}`);
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
