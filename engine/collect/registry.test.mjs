import { strict as assert } from 'node:assert';
import { register, get, list } from './registry.mjs';
import { DESCRIPTORS, ALL_DESCRIPTORS } from './descriptors.mjs';
import { collectM1, M1_TYPES } from './entraAdapter.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));
const M1_ORDER = ['user', 'authenticationStrengthPolicy', 'group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy'];

// Widened 2026-09-08 after measuring naturalKeyFor()/naturalKey() against a
// real tenant for all 52 original catalog types (54 after task-149, 59 after issue #156) — see engine/collect/descriptors.mjs's
// file header for the measurement and the full list of what was left out.
const WIDENED_TYPES = [
  'organization', 'domain', 'subscribedSku', 'groupSetting', 'administrativeUnit', 'identityProvider',
  'application', 'servicePrincipal', 'directoryRole', 'roleDefinition',
  'authenticationMethodsPolicy', 'authorizationPolicy', 'crossTenantAccessPolicy',
  'crossTenantAccessPolicyPartner', 'permissionGrantPolicy', 'adminConsentRequestPolicy',
  'accessReviewScheduleDefinition', 'deviceConfiguration', 'deviceCompliancePolicy',
  'configurationPolicy', 'deviceManagementRoleDefinition', 'mobileApp',
];
const ENABLED_TYPES = CATALOG.map((entry) => entry.type);

// --- regression guard: the original six M1 types are still enabled, first, in order ---
assert.deepEqual(
  DESCRIPTORS.slice(0, 6).map((d) => d.type),
  M1_ORDER,
  'the six previously-live M1 types stay enabled, first, in their historical order',
);
assert.deepEqual(
  M1_TYPES.slice(0, 6),
  M1_ORDER,
  'M1_TYPES still starts with exactly the original six, in order',
);
for (const type of M1_ORDER) {
  assert.ok(M1_TYPES.includes(type), `previously-live type ${type} is still in M1_TYPES`);
}

// --- full catalogue: the metadata and the actual registry must both resolve ---
assert.deepEqual(
  DESCRIPTORS.map((d) => d.type).sort(),
  [...ENABLED_TYPES].sort(),
  'DESCRIPTORS covers exactly the full catalogue',
);
assert.deepEqual([...M1_TYPES].sort(), [...ENABLED_TYPES].sort(), 'M1_TYPES matches the same enabled set');

assert.equal(CATALOG.length, 59);
assert.equal(list().length, 59);
assert.deepEqual(list().map((d) => d.type).sort(), [...ENABLED_TYPES].sort(), 'registry-vs-catalogue diff is empty');
for (const entry of CATALOG) {
  assert.equal(get(entry.type).descriptor.type, entry.type);
  assert.equal(typeof get(entry.type).adapter.collect, 'function');
}

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

// DESCRIPTORS is the collected prefix of ALL_DESCRIPTORS — the same descriptor objects.
assert.deepEqual(
  ALL_DESCRIPTORS.slice(0, DESCRIPTORS.length).map((d) => d.type).sort(),
  DESCRIPTORS.map((d) => d.type).sort(),
);
// ...and its own first six are still the M1 six, in order (spec-pinned prefix).
assert.deepEqual(ALL_DESCRIPTORS.slice(0, 6).map((d) => d.type), M1_ORDER);

// --- natural-key safety: no ENABLED type may sit on the bare displayName fallback
// silently. Either it declares a real strategy, or it is on this allowlist —
// pinned here because the 2026-09-08 measurement showed each of these types
// resolves to a real, human-assigned name for every object in the probe
// tenant (zero collisions, zero GUID-shaped keys). A type newly added to
// DESCRIPTORS with an unlisted bare 'displayName' strategy fails this test,
// which is the point: it forces a measurement before collection is widened
// further, exactly as engine/collect/descriptors.mjs's header describes.
const JUSTIFIED_DISPLAYNAME_FALLBACK = new Set([
  'organization',
  'groupSetting',
  'administrativeUnit',
  'identityProvider',
  'authenticationMethodsPolicy',
  'authorizationPolicy',
  'crossTenantAccessPolicy',
  'permissionGrantPolicy',
  'accessReviewScheduleDefinition',
  'deviceConfiguration',
  'deviceCompliancePolicy',
  'configurationPolicy',
  'deviceManagementRoleDefinition',
  'mobileApp',
]);
// Scoped to the newly-widened types only: the original six are pinned by the
// regression guard above and already declared their (pre-existing)
// naturalKeyStrategy before this widening — re-litigating them here is out
// of scope for this pass.
for (const d of DESCRIPTORS) {
  if (!WIDENED_TYPES.includes(d.type)) continue;
  if (d.naturalKeyStrategy !== 'displayName') continue;
  assert.ok(
    JUSTIFIED_DISPLAYNAME_FALLBACK.has(d.type),
    `${d.type} is enabled on the bare displayName fallback without a measured justification — ` +
      `add it to JUSTIFIED_DISPLAYNAME_FALLBACK only after measuring zero collisions and zero GUID-fallback`,
  );
}
// The allowlist itself must not rot: every type on it must actually be enabled.
for (const type of JUSTIFIED_DISPLAYNAME_FALLBACK) {
  assert.ok(DESCRIPTORS.some((d) => d.type === type), `justified type ${type} must be enabled`);
}

// --- operator decision: users stay on the DAILY tier --------------------------
// Regression test: the catalog is the source of truth, and it must keep user
// on tier2. Flipping the catalog entry to tier1 must fail here.
assert.equal(CATALOG_BY_TYPE.get('user').criticality, 'tier2', 'operator decision: user stays on tier2 (daily)');
assert.equal(ALL_DESCRIPTORS.find((d) => d.type === 'user').criticality, 'tier2', 'user descriptor resolves to tier2');

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
assert.equal(listed.length, DESCRIPTORS.length + 1, 'list() returns all registered descriptors');
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
const collected = await collectM1(fakeReader, { tenantId: 'fixture-tenant' });
assert.equal(collected.length, M1_TYPES.length);
assert.deepEqual(collected.map(([type]) => type), M1_TYPES, 'same types, same order as M1_TYPES');
for (const [type, items] of collected) {
  assert.ok(Array.isArray(items) && items.length === 1, `${type} collected via its registered adapter`);
}
assert.equal(seen.length, M1_TYPES.length, 'one reader.collect call per type');

// collectM1 is order-independent against the reader: entries are keyed by type.
const byType = Object.fromEntries(collected);
assert.deepEqual(Object.keys(byType).sort(), [...M1_TYPES].sort());

console.log('registry.test.mjs — all assertions passed');
