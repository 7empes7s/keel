/** Spec §11.1. Buckets self-tune on observed Retry-After, which is
 * authoritative over documented limits.
 *
 * Wave 2 RST: writes inside a wave run concurrently, so one Retry-After also
 * pauses the whole bucket. Every caller that has not slept that delay itself
 * waits out `pauseRemainingSeconds` before its next attempt, instead of
 * running into the same throttle. */
export class ThrottleGovernor {
  #buckets = new Map();
  #seeds;
  #now;

  constructor(seeds, { now = () => Date.now() } = {}) {
    this.#seeds = seeds;
    this.#now = now;
  }

  #key(tenant, workload, operationClass) {
    return `${tenant}/${workload}/${operationClass}`;
  }

  bucketFor(tenant, workload, operationClass) {
    const key = this.#key(tenant, workload, operationClass);
    if (!this.#buckets.has(key)) {
      const seed = this.#seeds[key];
      if (!seed) throw new Error(`no throttle seed for ${key} — every (tenant, workload, operationClass) must be seeded before use`);
      this.#buckets.set(key, { tokens: seed.capacity, capacity: seed.capacity,
        refillPerSecond: seed.refillPerSecond, lastRefill: this.#now(), pausedUntil: 0 });
    }
    return this.#buckets.get(key);
  }

  async acquire(tenant, workload, operationClass) {
    const bucket = this.bucketFor(tenant, workload, operationClass);
    for (;;) {
      this.#refill(bucket);
      if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  #refill(bucket) {
    const now = this.#now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond);
    bucket.lastRefill = now;
  }

  observeRetryAfter(tenant, workload, operationClass, retryAfterSeconds) {
    const bucket = this.bucketFor(tenant, workload, operationClass);
    const observedRate = 1 / Math.max(retryAfterSeconds, 1);
    if (observedRate < bucket.refillPerSecond) bucket.refillPerSecond = observedRate;
    const until = this.#now() + Math.max(retryAfterSeconds, 0) * 1000;
    if (until > bucket.pausedUntil) bucket.pausedUntil = until;
  }

  /** Seconds left on the latest Retry-After this bucket observed, 0 when none. */
  pauseRemainingSeconds(tenant, workload, operationClass) {
    const bucket = this.bucketFor(tenant, workload, operationClass);
    const remaining = (bucket.pausedUntil - this.#now()) / 1000;
    return remaining > 0 ? remaining : 0;
  }
}
