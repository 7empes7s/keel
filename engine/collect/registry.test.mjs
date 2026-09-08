import { strict as assert } from 'node:assert';
import { register, get, list } from './registry.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { collectM1, M1_TYPES } from './entraAdapter.mjs';
import { CRITICALITY, BLAST_RADIUS } from '../cir/canonicalize.mjs';

// --- the six M1 types are seeded as descriptors -------------------------------
assert.equal(DESCRIPTORS.length, 6, 'exactly the six M1 types are seeded — the other 46 are Phase 3');
assert.deepEqual(
  DESCRIPTORS.map((d) => d.type),
  ['user', 'authenticationStrengthPolicy', 'group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy'],
);

// criticality/blastRadius are read from the single source in canonicalize.mjs,
// not re-declared.
for (const d of DESCRIPTORS) {
  assert.equal(d.criticality, CRITICALITY[d.type], `${d.type} criticality must come from canonicalize.mjs`);
  assert.equal(d.blastRadius, BLAST_RADIUS[d.type], `${d.type} blastRadius must come from canonicalize.mjs`);
  assert.ok(['full', 'partial', 'read-only', 'unprotectable'].includes(d.fidelity), `${d.type} fidelity`);
  assert.equal(typeof d.adapter, 'string', `${d.type} declares a static serving adapter id`);
  assert.ok(Array.isArray(d.unsupportedFields), `${d.type} unsupportedFields`);
  assert.equal(typeof d.remappable, 'boolean', `${d.type} remappable`);
  assert.equal(typeof d.naturalKeyStrategy, 'string', `${d.type} naturalKeyStrategy`);
}

// --- register / get / list -----------------------------------------------------
const widgetDescriptor = {
  type: 'testWidget',
  fidelity: 'partial',
  unsupportedFields: [],
  criticality: 'tier3',
  blastRadius: 'cosmetic',
  naturalKeyStrategy: 'displayName',
  remappable: true,
  adapter: 'test/widget',
};
const widgetAdapter = { collect: async () => [{ id: 'w1' }] };
register(widgetDescriptor, widgetAdapter);

const got = get('testWidget');
assert.equal(got.descriptor, widgetDescriptor);
assert.equal(got.adapter, widgetAdapter);

const listed = list();
assert.equal(listed.length, 7, 'list() returns all registered descriptors');
assert.ok(listed.some((d) => d.type === 'testWidget'));
for (const type of M1_TYPES) assert.ok(listed.some((d) => d.type === type), `list() contains ${type}`);

assert.throws(() => get('no-such-type'), /no adapter registered/, 'unknown type throws');
assert.throws(() => register(widgetDescriptor, widgetAdapter), /already registered/, 'duplicate type throws');
assert.throws(() => register({ ...widgetDescriptor, type: 'noCollect' }, {}), /collect/, 'adapter without collect() throws');

// --- collectM1 runs through the registry, same external shape -----------------
const seen = [];
const fakeReader = {
  collect: async (version, path, opts) => {
    seen.push({ version, path, pageCap: opts.pageCap });
    return { items: [{ id: `${path}#1` }], error: null };
  },
};
const collected = await collectM1(fakeReader);
assert.equal(collected.length, 6);
assert.deepEqual(collected.map(([type]) => type), M1_TYPES, 'same six types, same order');
for (const [type, items] of collected) {
  assert.ok(Array.isArray(items) && items.length === 1, `${type} collected via its registered adapter`);
}
assert.equal(seen.length, 6, 'one reader.collect call per type');

// collectM1 is order-independent against the reader: entries are keyed by type.
const byType = Object.fromEntries(collected);
assert.deepEqual(Object.keys(byType).sort(), [...M1_TYPES].sort());

console.log('registry.test.mjs — all assertions passed');
