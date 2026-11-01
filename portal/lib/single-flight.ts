// Callers that ask while a read is already running share its answer instead of starting
// another. Every open tab's menu reads the Overview's data, which is one of the portal's
// heaviest reads; run side by side, those reads held several of the 8 database
// connections at once, so page loads waited and got "Keel is busy" (HTTP 503).
// Nothing is kept once the read settles: the next caller always gets a fresh read.
export function singleFlight<T>(load: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    if (!running) {
      running = load().finally(() => {
        running = null;
      });
    }
    return running;
  };
}
