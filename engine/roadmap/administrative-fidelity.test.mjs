/**
 * Roadmap task-109 boundary tests: bounded administrative configuration
 * restore qualification.
 *
 * Exercises engine/restore/administrativeOperations.mjs's operation records
 * through the production applyWave() and applyPatches() writer paths, the
 * administrative batch of engine/coverage/qualification.mjs,
 * tools/qualification/operations.mjs's batch runner and cli/keel-restore.mjs's
 * snapshot-coverage read against an isolated test database. Microsoft Graph is
 * an in-memory fake only; no tenant is read or written. Required mutation
 * checks:
 *
 * - Write global reference template.
 * - Skip source-authority guard.
 * - Delete from partial observation.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { fakeGraph, main as operationsMain, runExpansionBatch } from '../../tools/qualification/operations.mjs';
import { observedCoverageFor } from '../../cli/keel-restore.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import {
  EXPANSION_INVENTORY, UNRECOVERABLE_CONFIGURATION, buildExpansionInventory, expansionFor, qualificationFor,
} from '../coverage/qualification.mjs';
import { namedValueDrift, writableProjection } from '../reconcile/writableProjection.mjs';
import { applyPatches, applyWave } from '../restore/applyEngine.mjs';
import {
  ADMINISTRATIVE_OPERATION_RECORDS, GLOBAL_REFERENCE_TEMPLATE_TYPES, administrativePatchRefusal,
  administrativePostStateRefusal, administrativeWriteRefusal, buildAdministrativeFamilyLedger,
} from '../restore/administrativeOperations.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const SETTINGS = '/groupSettings';
const UNITS = '/directory/administrativeUnits';
const GROUP_UNIFIED = '62375ab9-6b52-47ed-826b-58e47e0e304b';
const GUEST_SETTINGS = 'dffd5d46-495d-40a9-8e21-954ff55e198a';
const COMPLETE = Object.freeze({ groupSetting: Object.freeze({ outcome: 'complete', itemCount: 2 }) });
const DELETE_GUARD = Object.freeze({ breakGlassUserIds: ['break-glass'], breakGlassGroupIds: [], keelAppIds: [], caPolicies: [] });

/** fakeGraph plus the body of every write, and an optional read-back override. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(result.body) } : result;
  };
  graph.bodies = bodies;
  return graph;
}

/** readAfterWrite waits 3s between stale reads; a read-back that never verifies
 * would make a test take 15s. Timers fire immediately for that test only. */
function immediateTimers(t) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = original; });
}

const unifiedSetting = Object.freeze({
  id: 'setting-1',
  displayName: 'Group.Unified',
  templateId: GROUP_UNIFIED,
  values: Object.freeze([
    Object.freeze({ name: 'AllowGuestsToAccessGroups', value: 'false' }),
    Object.freeze({ name: 'EnableGroupCreation', value: 'false' }),
    Object.freeze({ name: 'UsageGuidelinesUrl', value: 'https://contoso.example/groups' }),
  ]),
});

const financeUnit = Object.freeze({
  id: 'unit-1',
  displayName: 'Finance EU',
  description: 'Finance staff in the EU',
  visibility: 'HiddenMembership',
  isMemberManagementRestricted: false,
  membershipType: 'Assigned',
});

function setValues(setting, overrides) {
  return { ...setting, values: setting.values.map((entry) => (Object.hasOwn(overrides, entry.name) ? { ...entry, value: overrides[entry.name] } : entry)) };
}

/** Seeds the fake target with `live` and returns the planned resource. */
function planned(graph, resourceType, verb, desired, live, extra = {}) {
  const collection = resourceType === 'groupSetting' ? SETTINGS : UNITS;
  if (live) graph.objects.set(`${collection}/${live.id}`, live);
  return {
    naturalKey: `${resourceType}:${(desired ?? live).displayName}`, resourceType, verb, payload: desired,
    references: [], blastRadius: 'access-affecting', targetId: live?.id,
    live: live ? { state: 'present', targetId: live.id, payload: live } : null,
    ...extra,
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', deletionGuardOptions: DELETE_GUARD, ...options,
});

// ------------------------------------------------- ledger: the qualified subset and the rest

test('three operation records, each a fixture-tested registration; every sibling verb stays unsupported', () => {
  assert.ok(ADMINISTRATIVE_OPERATION_RECORDS.length <= 3, 'the task starts with at most three records');
  assert.deepEqual(ADMINISTRATIVE_OPERATION_RECORDS.map((record) => `${record.resourceType} ${record.operation}`),
    ['administrativeUnit update', 'groupSetting update', 'groupSetting delete']);
  for (const record of ADMINISTRATIVE_OPERATION_RECORDS) {
    const capability = capabilityFor(record.resourceType, record.operation);
    assert.equal(capability.claim, 'fixture-tested', `${record.resourceType} ${record.operation}`);
    assert.equal(capability.proofRef, 'engine/roadmap/administrative-fidelity.test.mjs');
  }
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('administrativeUnit', operation).claim)), ['update']);
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('groupSetting', operation).claim)), ['update', 'delete']);
  for (const type of [...GLOBAL_REFERENCE_TEMPLATE_TYPES, 'organization', 'domain', 'subscribedSku']) {
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), [], type);
  }
  assert.equal(qualificationFor('groupSetting').decision, 'automated');
  assert.equal(qualificationFor('administrativeUnit').decision, 'automated');
  assert.equal(qualificationFor('directorySettingTemplate').decision, 'manual');
});

test('the evidence report names what cannot be recovered and carries no coverage percentage', () => {
  const ledger = buildAdministrativeFamilyLedger();
  assert.deepEqual(ledger.families.map((family) => family.resourceType).sort(),
    ['administrativeUnit', 'directorySettingTemplate', 'domain', 'groupSetting', 'organization', 'subscribedSku']);
  const byType = new Map(ledger.families.map((family) => [family.resourceType, family]));
  const unit = byType.get('administrativeUnit');
  assert.deepEqual({ status: unit.status, restoreScope: unit.restoreScope }, { status: 'qualified-subset', restoreScope: 'partial' });
  assert.deepEqual(unit.operations.map((op) => [op.operation, op.writableFields.join(',')]), [['update', 'description,displayName']]);
  // The unsupported relationship stays explicit: membership and scoped roles.
  const unitRelationships = unit.unrecoverable.filter((item) => item.kind === 'relationship').map((item) => item.name);
  assert.deepEqual(unitRelationships, ['members', 'scopedRoleMembers']);
  assert.ok(byType.get('groupSetting').unrecoverable.some((item) => item.name === 'templateId' && item.kind === 'relationship'));
  assert.deepEqual(byType.get('directorySettingTemplate').refusals, ['global reference template: never written']);
  for (const family of ledger.families) {
    assert.ok(family.unrecoverable.length > 0, `${family.resourceType} says what it cannot recover`);
    for (const item of family.unrecoverable) assert.ok(['configuration', 'relationship'].includes(item.kind) && item.reason.length > 0);
  }
  const serialised = JSON.stringify(ledger);
  assert.doesNotMatch(serialised, /percent|%|"ratio"|"coverage"/i, 'no total coverage figure');

  // The coverage record carries the same list; an unassessed type is null, never [].
  assert.deepEqual(expansionFor('administrativeUnit').unrecoverable, UNRECOVERABLE_CONFIGURATION.administrativeUnit);
  assert.equal(expansionFor('group').unrecoverable, null);
  // The inventory still refuses a declared field: the list cannot be smuggled in as a claim.
  const smuggled = { ...EXPANSION_INVENTORY, groupSetting: { ...EXPANSION_INVENTORY.groupSetting, unrecoverable: [] } };
  assert.throws(() => buildExpansionInventory({ inventory: smuggled }), /unrecognised fields unrecoverable/);
});

// ------------------------------------------------- global reference templates and synced objects refuse

test('mutation check: a global reference template is never written, whatever the verb', async () => {
  const graph = recordingGraph();
  const template = { id: GROUP_UNIFIED, displayName: 'Group.Unified', values: [{ name: 'EnableGroupCreation', defaultValue: 'true' }] };
  for (const verb of ['create', 'update', 'delete']) {
    for (const resourceType of GLOBAL_REFERENCE_TEMPLATE_TYPES) {
      const resource = { naturalKey: `${resourceType}:t`, resourceType, verb, payload: verb === 'delete' ? null : template, references: [], targetId: GROUP_UNIFIED };
      const refusal = administrativeWriteRefusal(resource, verb, { observedCoverage: { [resourceType]: { outcome: 'complete' } } });
      assert.deepEqual(refusal?.outcome, 'skipped', `${resourceType} ${verb}`);
      assert.match(refusal.reason, /global reference template/);
      const result = await run(graph, [resource], { observedCoverage: { [resourceType]: { outcome: 'complete' } } });
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0].reason, /global reference template: .* is never written/);
    }
  }
  assert.equal(graph.bodies.length, 0, 'refused before any write');
});

test('mutation check: a setting is never rebound to another template, and a template id never reaches a PATCH', async (t) => {
  // The snapshot's setting is bound to a different global template than the live one.
  const graph = recordingGraph();
  const rebound = planned(graph, 'groupSetting', 'update', { ...unifiedSetting, templateId: GUEST_SETTINGS }, unifiedSetting);
  const result = await run(graph, [rebound]);
  assert.match(result.failed[0]?.error ?? '', /template change refused — the live setting is bound to global reference template/);
  assert.equal(graph.bodies.length, 0);

  // The writer-boundary check is independent of writableProjection.
  assert.equal(writableProjection(unifiedSetting, 'groupSetting').templateId, undefined, 'templateId is immutable');
  assert.match(administrativePatchRefusal('groupSetting', { values: [], templateId: GUEST_SETTINGS }), /templateId outside the proven writable fields/);
  assert.match(administrativePatchRefusal('groupSetting', { displayName: 'x' }), /displayName outside/);
  assert.equal(administrativePatchRefusal('groupSetting', { values: [] }), null);

  // A setting whose template changed under the write fails; it is never an
  // immutable, not-remediable residual.
  immediateTimers(t);
  const swapped = recordingGraph({ readOverride: (body) => ({ ...body, templateId: GUEST_SETTINGS }) });
  const drifted = setValues(unifiedSetting, { EnableGroupCreation: 'true' });
  const swap = await run(swapped, [planned(swapped, 'groupSetting', 'update', unifiedSetting, drifted)]);
  assert.match(swap.failed[0]?.error ?? '', /post-state: setting read back bound to template/);
  assert.deepEqual(swap.notRemediable, []);
});

test('mutation check: an object whose source of authority is not the cloud is refused for every verb', async () => {
  const graph = recordingGraph();
  const cases = [
    planned(graph, 'administrativeUnit', 'update', { ...financeUnit, displayName: 'Finance' }, financeUnit, { sourceAuthority: 'hybrid' }),
    planned(graph, 'administrativeUnit', 'update', { ...financeUnit, displayName: 'Finance' }, financeUnit, { sourceAuthority: 'on-premises' }),
    planned(graph, 'administrativeUnit', 'update', { ...financeUnit, displayName: 'Finance' }, financeUnit, { sourceAuthority: 'garbled' }),
    planned(graph, 'administrativeUnit', 'update', { ...financeUnit, displayName: 'Finance', onPremisesSyncEnabled: true }, financeUnit),
    planned(graph, 'groupSetting', 'update', unifiedSetting, setValues(unifiedSetting, { EnableGroupCreation: 'true' }), { sourceAuthority: 'hybrid' }),
    // A delete: applyWave's generic sync check never runs before a delete's own guard.
    planned(graph, 'groupSetting', 'delete', null, unifiedSetting, { sourceAuthority: 'hybrid' }),
    // A group-scoped setting whose parent group is synchronised from on-premises.
    planned(graph, 'groupSetting', 'update', unifiedSetting, setValues(unifiedSetting, { EnableGroupCreation: 'true' }), {
      parent: { naturalKey: 'group:Finance', resourceType: 'group', payload: { displayName: 'Finance', onPremisesSyncEnabled: true } },
    }),
  ];
  for (const resource of cases) {
    const refusal = administrativeWriteRefusal(resource, resource.verb, { observedCoverage: COMPLETE });
    assert.equal(refusal?.outcome, 'skipped', resource.naturalKey);
    assert.match(refusal.reason, /^source authority: administrative write refused — /);
  }
  const result = await run(graph, cases, { observedCoverage: COMPLETE });
  assert.equal(result.skipped.length, cases.length);
  for (const entry of result.skipped) assert.match(entry.reason, /source authority: administrative write refused/);
  assert.equal(graph.bodies.length, 0, 'refused before any journal or write');

  // A cloud group-scoped setting is still unsupported: only tenant-wide settings are qualified.
  const scoped = planned(graph, 'groupSetting', 'update', unifiedSetting, setValues(unifiedSetting, { EnableGroupCreation: 'true' }), {
    parent: { naturalKey: 'group:Cloud', resourceType: 'group', payload: { displayName: 'Cloud' } },
  });
  assert.match((await run(graph, [scoped])).failed[0]?.error ?? '', /group-scoped setting has no qualified operation/);
});

// ------------------------------------------------- qualified operations verify post-state and dependencies

test('administrative unit update PATCHes name and description only and verifies the read-back', async (t) => {
  const graph = recordingGraph();
  const live = { ...financeUnit, displayName: 'Finance (renamed)', description: 'changed' };
  const result = await run(graph, [planned(graph, 'administrativeUnit', 'update', financeUnit, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path: `${UNITS}/unit-1`, body: { displayName: 'Finance EU', description: 'Finance staff in the EU' },
  }]);
  assert.equal(graph.objects.get(`${UNITS}/unit-1`).displayName, 'Finance EU');

  // Visibility is set only at creation: its drift is not remediable, never PATCHed.
  const hidden = recordingGraph();
  const visible = await run(hidden, [planned(hidden, 'administrativeUnit', 'update', financeUnit, { ...financeUnit, visibility: null })]);
  assert.equal(hidden.bodies[0]?.body.visibility, undefined);
  assert.deepEqual(visible.notRemediable.map((entry) => entry.immutable), [['visibility']]);

  // A unit that does not read back as written fails.
  immediateTimers(t);
  const stale = recordingGraph({ readOverride: (body) => ({ ...body, description: 'stale' }) });
  const unverified = await run(stale, [planned(stale, 'administrativeUnit', 'update', financeUnit, { ...financeUnit, description: 'changed' })]);
  assert.match(unverified.failed[0]?.error ?? '', /post-state: description did not read back as written/);
  assert.equal(administrativePostStateRefusal({ resourceType: 'administrativeUnit', payload: financeUnit }, financeUnit), null);

  // No live object observed: the update cannot be checked against it.
  const blind = recordingGraph();
  const noLive = await run(blind, [{ ...planned(blind, 'administrativeUnit', 'update', financeUnit, financeUnit), live: null }]);
  assert.match(noLive.failed[0]?.error ?? '', /no live administrativeUnit was observed/);
  assert.equal(blind.bodies.length, 0);
});

test('setting update writes the values only after the template dependencies hold, then verifies each value', async () => {
  const graph = recordingGraph();
  const live = setValues(unifiedSetting, { AllowGuestsToAccessGroups: 'true', EnableGroupCreation: 'true' });
  const result = await run(graph, [planned(graph, 'groupSetting', 'update', unifiedSetting, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies.map((write) => [write.method, Object.keys(write.body)]), [['PATCH', ['values']]]);
  assert.deepEqual(graph.objects.get(`${SETTINGS}/setting-1`).values, unifiedSetting.values);

  // Parent definitions: a name the live template does not define refuses.
  const unknownName = recordingGraph();
  const extra = { ...unifiedSetting, values: [...unifiedSetting.values, { name: 'NotATemplateSetting', value: 'x' }] };
  assert.match((await run(unknownName, [planned(unknownName, 'groupSetting', 'update', extra, live)])).failed[0]?.error ?? '',
    /NotATemplateSetting not defined by the live setting's template/);
  // A value the template gained after the snapshot would be reset: refused, never silently.
  const grown = recordingGraph();
  const liveGrown = { ...live, values: [...live.values, { name: 'NewTemplateSetting', value: 'on' }] };
  assert.match((await run(grown, [planned(grown, 'groupSetting', 'update', unifiedSetting, liveGrown)])).failed[0]?.error ?? '',
    /template now defines NewTemplateSetting, which the snapshot never observed/);
  // A snapshot with no template binding, or one repeating a value, refuses.
  const unbound = recordingGraph();
  assert.match((await run(unbound, [planned(unbound, 'groupSetting', 'update', { ...unifiedSetting, templateId: null }, live)])).failed[0]?.error ?? '',
    /names no settings template/);
  const repeated = recordingGraph();
  const twice = { ...unifiedSetting, values: [...unifiedSetting.values, unifiedSetting.values[0]] };
  assert.match((await run(repeated, [planned(repeated, 'groupSetting', 'update', twice, live)])).failed[0]?.error ?? '', /repeats value AllowGuestsToAccessGroups/);
  assert.equal(unknownName.bodies.length + grown.bodies.length + unbound.bodies.length + repeated.bodies.length, 0);

  // The post-state check compares by name, not position, and names a value that did not stick.
  assert.equal(administrativePostStateRefusal({ resourceType: 'groupSetting', payload: unifiedSetting },
    { ...unifiedSetting, values: [...unifiedSetting.values].reverse() }), null);
  assert.match(administrativePostStateRefusal({ resourceType: 'groupSetting', payload: unifiedSetting }, live), /AllowGuestsToAccessGroups, EnableGroupCreation did not read back/);
  assert.deepEqual(namedValueDrift(unifiedSetting.values, undefined).undefinedNames.length, 3, 'a missing list is empty, never a match');
});

// ------------------------------------------------- partial collection cannot authorise delete

test('mutation check: a delete needs a complete snapshot observation of the collection', async () => {
  for (const coverage of [null, {}, { groupSetting: { outcome: 'partial', itemCount: 1 } }, { groupSetting: { outcome: 'failed' } },
    { groupSetting: { outcome: 'not-requested' } }, { group: { outcome: 'complete' } }]) {
    const graph = recordingGraph();
    const result = await run(graph, [planned(graph, 'groupSetting', 'delete', null, unifiedSetting)], { observedCoverage: coverage });
    assert.match(result.failed[0]?.error ?? '', /partial observation cannot authorise delete/, JSON.stringify(coverage));
    assert.equal(graph.bodies.length, 0, 'refused before any journal or write');
    assert.ok(graph.objects.has(`${SETTINGS}/setting-1`), 'the live setting is untouched');
  }

  for (const outcome of ['complete', 'complete-empty']) {
    const graph = recordingGraph();
    const result = await run(graph, [planned(graph, 'groupSetting', 'delete', null, unifiedSetting)], { observedCoverage: { groupSetting: { outcome } } });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [`DELETE ${SETTINGS}/setting-1`]);
    assert.equal(graph.objects.has(`${SETTINGS}/setting-1`), false, 'verified absent');
  }

  // A delete whose snapshot still holds the object is never a delete.
  const graph = recordingGraph();
  const present = await run(graph, [planned(graph, 'groupSetting', 'delete', unifiedSetting, unifiedSetting)], { observedCoverage: COMPLETE });
  assert.match(present.failed[0]?.error ?? '', /the snapshot still contains this object/);
  // An administrative unit delete has no record at all.
  const unitGraph = recordingGraph();
  const unit = await run(unitGraph, [planned(unitGraph, 'administrativeUnit', 'delete', null, financeUnit)], { observedCoverage: { administrativeUnit: { outcome: 'complete' } } });
  assert.match(unit.failed[0]?.error ?? '', /no administrative operation record covers administrativeUnit delete/);
  assert.equal(graph.bodies.length + unitGraph.bodies.length, 0);
});

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

test('the restore CLI reads delete evidence from the source snapshot of its own tenant only', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const insert = async (tenantRef, digest) => (await client.query(
    `INSERT INTO snapshot (tenant_ref, status, coverage_digest, completed_at) VALUES ($1, 'complete', $2, now()) RETURNING id`,
    [tenantRef, digest],
  )).rows[0].id;
  const partial = await insert('tenant-a', { groupSetting: { outcome: 'partial', itemCount: 1 } });
  const complete = await insert('tenant-a', { groupSetting: { outcome: 'complete', itemCount: 2 } });
  const foreign = await insert('tenant-b', { groupSetting: { outcome: 'complete', itemCount: 2 } });

  const deletion = (graph) => [planned(graph, 'groupSetting', 'delete', null, unifiedSetting)];
  const attempt = async (snapshotId, tenantRef) => {
    const graph = recordingGraph();
    const resources = deletion(graph);
    const observedCoverage = await observedCoverageFor(client, { resources, snapshotId, tenantRef });
    return { observedCoverage, result: await run(graph, resources, { observedCoverage }), graph };
  };

  const fromPartial = await attempt(partial, 'tenant-a');
  assert.equal(fromPartial.observedCoverage.groupSetting.outcome, 'partial');
  assert.match(fromPartial.result.failed[0]?.error ?? '', /collection is partial/);
  assert.equal(fromPartial.graph.bodies.length, 0);

  const fromForeign = await attempt(foreign, 'tenant-a');
  assert.equal(fromForeign.observedCoverage, null, 'another tenant\'s snapshot is no evidence');
  assert.match(fromForeign.result.failed[0]?.error ?? '', /not recorded/);

  const fromComplete = await attempt(complete, 'tenant-a');
  assert.deepEqual(fromComplete.result.failed, []);
  assert.deepEqual(fromComplete.graph.bodies.map((write) => write.method), ['DELETE']);

  // Without a governed delete in the plan, nothing is read.
  const untouched = { query: async () => { throw new Error('no query expected'); } };
  assert.equal(await observedCoverageFor(untouched, { resources: [{ resourceType: 'group', verb: 'delete' }], snapshotId: complete, tenantRef: 'tenant-a' }), null);
});

// ------------------------------------------------- integration: patches, batch runner and CLI

test('a deferred reference patch is never sent for a governed administrative type', async () => {
  const graph = recordingGraph();
  const result = await applyPatches(graph, governor, [{
    naturalKey: 'groupSetting:Group.Unified', resourceType: 'groupSetting', field: 'templateId', symbol: 'directorySettingTemplate:Group.Unified',
  }], {
    targetTenant: 'fixture', mode: 'enforce',
    appliedIds: new Map([['directorySettingTemplate:Group.Unified', GUEST_SETTINGS], ['groupSetting:Group.Unified', 'setting-1']]),
  });
  assert.match(result.failed[0]?.reason ?? '', /no proven deferred reference patch for groupSetting/);
  assert.equal(graph.bodies.length, 0);
});

test('the administrative batch runner drives the subset through applyWave and reports what cannot be recovered', async () => {
  const report = await runExpansionBatch('administrative-configuration');
  assert.deepEqual(report.operations.map((op) => `${op.resourceType} ${op.operation} ${op.result}`).sort(),
    ['administrativeUnit update passed', 'groupSetting delete passed', 'groupSetting update passed']);
  assert.ok(report.operations.every((op) => op.synthetic === true));
  assert.ok(report.administrativeLedger.families.some((family) => family.resourceType === 'administrativeUnit'
    && family.unrecoverable.some((item) => item.name === 'members')));

  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  assert.equal(await operationsMain({ argv: ['--batch', 'administrative-configuration'], out }), 0);
  const text = lines.join('\n');
  assert.match(text, /directorySettingTemplate: refused — global reference template: never written/);
  assert.match(text, /groupSetting delete checks: .*complete snapshot observation of the collection/);
  assert.match(text, /administrativeUnit cannot recover relationship members: /);
  assert.doesNotMatch(text, /%/);
});
