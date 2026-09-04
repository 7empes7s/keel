import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { getToken } from '../../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { collectM1, M1_TYPES } from './entraAdapter.mjs';

const config = JSON.parse(readFileSync('/etc/keel/tenant.json', 'utf8'));
let token = await getToken(config);
const reader = new GraphReader(async () => token.accessToken);

const collected = await collectM1(reader);
const byType = Object.fromEntries(collected);

// Every M1 type is present, even if empty — a missing key would mean a silent
// skip rather than "the tenant genuinely has zero of these."
for (const type of M1_TYPES) {
  assert.ok(type in byType, `missing type ${type} in collection result`);
  assert.ok(Array.isArray(byType[type]));
}

// The sandbox tenant has at least one Conditional Access policy and at least
// one active role assignment (confirmed during the probe's own measurement
// run) — a genuinely empty result here would indicate the query is wrong, not
// that the tenant is empty.
assert.ok(byType.conditionalAccessPolicy.length > 0, 'expected at least 1 CA policy');
assert.ok(byType.roleAssignment.length > 0, 'expected at least 1 role assignment');

// canonicalizeAll must accept this shape without throwing.
const { canonicalizeAll } = await import('../cir/canonicalize.mjs');
const resources = canonicalizeAll(collected);
assert.ok(resources.length >= byType.group.length + byType.roleAssignment.length
  + byType.namedLocation.length + byType.conditionalAccessPolicy.length + byType.user.length);

console.log(`entraAdapter.test.mjs — collected ${resources.length} resources — all assertions passed`);
