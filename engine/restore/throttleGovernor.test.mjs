import { strict as assert } from 'node:assert';
import { ThrottleGovernor } from './throttleGovernor.mjs';

const seeds = { 'target-tenant/entra/write': { capacity: 5, refillPerSecond: 5 / 10 } };
const gov = new ThrottleGovernor(seeds);

const bucket = gov.bucketFor('target-tenant', 'entra', 'write');
assert.equal(bucket.tokens, 5); // starts full

// Acquire drains a token synchronously when tokens are available.
await gov.acquire('target-tenant', 'entra', 'write');
assert.equal(bucket.tokens, 4);

// Retry-After lower than the seed assumed re-tunes the bucket's refill rate
// downward — documented limits are a starting point, not authoritative (spec
// §11.1). A fixture where the observed rate matches the seed would prove
// nothing; this one is deliberately stricter than the seed.
gov.observeRetryAfter('target-tenant', 'entra', 'write', 30); // observed: only 1 token per 30s safe
assert.ok(bucket.refillPerSecond <= 1 / 30, `expected refill <= ${1 / 30}, got ${bucket.refillPerSecond}`);

// An unseeded (tenant, workload, operationClass) triple throws rather than
// silently allowing unlimited throughput.
assert.throws(() => gov.bucketFor('other-tenant', 'entra', 'write'));

console.log('throttleGovernor.test.mjs — all assertions passed');
