/** Spec §11.1. Buckets self-tune on observed Retry-After, which is
 * authoritative over documented limits. */
export class ThrottleGovernor {
  #buckets = new Map();
  #seeds;

  constructor(seeds) {
    this.#seeds = seeds;
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
        refillPerSecond: seed.refillPerSecond, lastRefill: Date.now() });
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
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond);
    bucket.lastRefill = now;
  }

  observeRetryAfter(tenant, workload, operationClass, retryAfterSeconds) {
    const bucket = this.bucketFor(tenant, workload, operationClass);
    const observedRate = 1 / Math.max(retryAfterSeconds, 1);
    if (observedRate < bucket.refillPerSecond) bucket.refillPerSecond = observedRate;
  }
}
