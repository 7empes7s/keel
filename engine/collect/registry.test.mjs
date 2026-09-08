import { strict as assert } from 'node:assert';
import { register, get, list } from './registry.mjs';
import { DESCRIPTORS, ALL_DESCRIPTORS } from './descriptors.mjs';
import { collectM1, M1_TYPES } from './entraAdapter.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));
const M1_ORDER = ['user', 'authenticationStrengthPolicy', 'group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy'];

// --- DESCRIPTORS stays exactly the six M1 types, in historical order ---------
assert.equal(DESCRIPTORS.length, 6, 'DESCRIPTORS is exactly the six M1 types');
assert.deepEqual(DESCRIPTORS.map((d) => d.type), M1_ORDER);
// The 46 new descriptors are known to the registry but NOT wired into
// collection: M1_TYPES (and therefore collectM1) is unchanged by this commit.
assert.deepEqual(M1_TYPES, M1_ORDER, 'M1_TYPES still returns exactly the original six');

// --- the registry knows every catalog type -----------------------------------
assert.equal(ALL_DESCRIPTORS.length, CATALOG.length, 'one descriptor per catalog entry');
for (const entry of CATALOG) {
  const d = ALL_DESCRIPTORS.find((x) => x.type === entry.type);
  assert.ok(d, `catalog type ${entry.type} has a descriptor`);
  // criticality / blastRadius come from the catalog — one source of truth.
  assert.equal(d.criticality, entry.criticality, `${entry.type} criticality must equal the catalog's`);
  assert.equal(d.blastRadius, entry.blastRadius, `${entry.type} blastRadius must equal the catalog's`);
}
for (const d of ALL_DESCRIPTORS) {
  assert.ok(CATALOG_BY_TYPE.has(d.type), `no descriptor for a type absent from the catalog: ${d.type}`);
  assert.ok(['full', 'partial', 'read-only', 'unprotectable'].includes(d.fidelity), `${d.type} fidelity`);
  assert.equal(d.adapter, `graph-native/${d.type}`, `${d.type} declares a static serving adapter id`);
  assert.ok(Array.isArray(d.unsupportedFields), `${d.type} unsupportedFields`);
  assert.equal(typeof d.remappable, 'boolean', `${d.type} remappable`);
  assert.equal(typeof d.naturalKeyStrategy, 'string', `${d.type} naturalKeyStrategy`);
}

// DESCRIPTORS is the M1 prefix of ALL_DESCRIPTORS — the same descriptor objects.
assert.deepEqual(ALL_DESCRIPTORS.slice(0, 6).map((d) => d.type), M1_ORDER);

// Fidelity is never overstated: only the four types with a write path in
// engine/restore/applyEngine.mjs's pathFor() may claim 'full'; everything
// else stays 'read-only' until a write path exists.
const WRITE_PATH_TYPES = new Set(['group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy']);
for (const d of ALL_DESCRIPTORS) {
  if (WRITE_PATH_TYPES.has(d.type)) {
    assert.equal(d.fidelity, 'full', `${d.type} has a write path`);
  } else {
    assert.equal(d.fidelity, 'read-only', `${d.type} has no write path — fidelity must stay read-only`);
  }
}

// --- operator decision: users stay on the DAILY tier --------------------------
// Regression test: the catalog is the source of truth, and it must keep user
// on tier2. Flipping the catalog entry to tier1 must fail here.
assert.equal(CATALOG_BY_TYPE.get('user').criticality, 'tier2', 'operator decision: user stays on tier2 (daily)');
assert.equal(ALL_DESCRIPTORS.find((d) => d.type === 'user').criticality, 'tier2', 'user descriptor resolves to tier2');

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
