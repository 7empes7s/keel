// Sends one request per chosen item, a few at a time, and keeps going when one fails.
// Accepting hundreds of changes used to fire every request at once: the portal's
// database pool (8 connections, 5 s wait) ran dry, most requests ended in 503, and the
// first failure hid how many had already been saved.

/** Requests in flight at once: half the pool, so pages keep loading while it runs. */
export const SEND_AT_ONCE = 4;

/** A busy answer (503, or a dropped connection) is tried again this many more times. */
export const BUSY_RETRIES = 2;

export type Sent<T, R> = { item: T; ok: true; value: R } | { item: T; ok: false; error: unknown };

/** Thrown by a send whose answer is worth trying again: the server was busy. */
export class BusyError extends Error {}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendEach<T, R>(
  items: readonly T[],
  send: (item: T) => Promise<R>,
  { atOnce = SEND_AT_ONCE, retries = BUSY_RETRIES, backoffMs = 400, onProgress }: {
    atOnce?: number; retries?: number; backoffMs?: number; onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Sent<T, R>[]> {
  const results: Sent<T, R>[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      for (let attempt = 0; ; attempt++) {
        try {
          results[index] = { item, ok: true, value: await send(item) };
          break;
        } catch (error) {
          if (error instanceof BusyError && attempt < retries) {
            await pause(backoffMs * 2 ** attempt);
            continue;
          }
          results[index] = { item, ok: false, error };
          break;
        }
      }
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, items.length)) }, worker));
  return results;
}
