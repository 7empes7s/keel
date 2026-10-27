/** A tenant's own compliance checks: written, validated, run with Keel's own after a
 * backup, read back by the Compliance reader, and removed. Also the known standards
 * (SCuBA, NIST) stay equal to their pinned sources. */
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { NIST_MAPPINGS } from '../../tools/qualification/benchmarkLicense.mjs';
import { controlFromRow, createOwnCheck, listOwnControls, valueAt, ownCheckChoices, removeOwnCheck, validateOwnCheck } from './ownChecks.mjs';
import { evaluateControl } from './evaluate.mjs';
import { controlFor, listControls } from './registry.mjs';
import { runComplianceChecks } from './runChecks.mjs';
import { NIST_REFS, SCUBA_COMMIT, SCUBA_POLICY_IDS, STANDARDS } from './standards.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const HOUR = 3_600_000;
const SHIPPED = listControls().length;

let ready = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!ready) { await client.query(schemaSql()); ready = true; }
  return client;
}

let sequence = 0;
const tenant = () => { sequence += 1; return `sha256:${createHash('sha256').update(`own-${sequence}`).digest('hex').slice(0, 16)}`; };

async function person(client, role) {
  const { rows: [row] } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id::text AS id', [`${role}-${randomUUID()}@contoso.example`]);
  await grantRole(client, { principalId: row.id, role, grantedBy: row.id });
  return row.id;
}

async function snapshot(client, tenantRef, completedAt, digest, resources = []) {
  const coverage = Object.fromEntries(Object.entries(digest).map(([type, outcome]) => [type, { outcome, itemCount: 0 }]));
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id::text AS id`,
    [tenantRef, new Date(completedAt.getTime() - 600_000), completedAt, coverage],
  );
  for (const [naturalKey, payload] of resources) {
    const type = naturalKey.slice(0, naturalKey.indexOf(':'));
    await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, 'high', 'access-affecting', 'full', '{}')`,
      [row.id, naturalKey, type, payload, canonicalHash(payload, type), HASH_VERSION],
    );
  }
  return row.id;
}

const policies = [
  ['conditionalAccessPolicy:KEEL-RT-mfa', { id: 'ca-1', displayName: 'KEEL-RT-mfa', state: 'enabled', conditions: { clientAppTypes: ['all'], users: { includeUsers: ['All'] } } }],
  ['conditionalAccessPolicy:KEEL-RT-old', { id: 'ca-2', displayName: 'KEEL-RT-old', state: 'disabled', conditions: { clientAppTypes: ['other'] } }],
];

const check = (extra = {}) => ({
  standard: 'Contoso hardening', name: 'Every sign-in rule is on', resourceType: 'conditionalAccessPolicy',
  field: 'state', operator: 'equals', expected: 'Enabled', appliesTo: 'every', severity: 'high', ...extra,
});

test('a check written by the tenant runs with Keel\'s own and shows under its standard', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await person(client, 'admin');
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { conditionalAccessPolicy: 'complete' }, policies);

  const every = await createOwnCheck(client, { principalId: admin, tenantRef, input: check(), now });
  const any = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'Some rule is on', appliesTo: 'any' }), now });
  const nested = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'Covers everyone', field: 'conditions.users.includeUsers', expected: 'All', appliesTo: 'any' }), now });
  assert.equal((await listOwnControls(client, { tenantRef })).length, 3);

  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  assert.equal(result.checked, SHIPPED + 3);
  const verdict = (row) => result.evaluations.find((evaluation) => evaluation.control_id === `own.${row.id}`);
  assert.equal(verdict(every).verdict, 'fail', 'one rule is off, so not every rule is on');
  // Every rule read is recorded, the failing one first.
  assert.deepEqual(verdict(every).details, [
    { subject: 'KEEL-RT-old', setting: 'state', value: 'disabled', expected: 'Enabled', ok: false },
    { subject: 'KEEL-RT-mfa', setting: 'state', value: 'enabled', expected: 'Enabled', ok: true },
  ]);
  assert.equal(verdict(every).profile, 'Contoso hardening');
  assert.equal(verdict(any).verdict, 'pass', 'strings compare without case');
  // A passing "at least one" check lists only what meets it, never a failing row.
  assert.deepEqual(verdict(any).details.map((line) => [line.subject, line.ok]), [['KEEL-RT-mfa', true]]);
  assert.equal(verdict(nested).verdict, 'fail', 'a list is not one plain value, so it never equals one');

  const { findings } = await complianceFindings(client, { tenantRef, now });
  const shown = findings.find((finding) => finding.controlId === `own.${every.id}`);
  assert.equal(shown.title, 'Every sign-in rule is on');
  assert.equal(shown.framework, 'own');
  assert.equal(shown.severity, 'high');
  assert.deepEqual([shown.own.standard, shown.own.field, shown.own.expected, shown.own.appliesTo], ['Contoso hardening', 'state', 'Enabled', 'every']);
  assert.equal(shown.evidence[0].resourceType, 'conditionalAccessPolicy');
  assert.equal(shown.evidence[0].snapshotId !== null, true, 'its evidence is matched to the backup it read');
  assert.equal(findings.find((finding) => finding.controlId.startsWith('keel-custom.')).own, null);

  const { rows } = await client.query("SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'compliance-own-check' ORDER BY seq", [tenantRef]);
  assert.deepEqual(rows.map((row) => [row.subject.action, row.subject.name]), [['created', 'Every sign-in rule is on'], ['created', 'Some rule is on'], ['created', 'Covers everyone']]);
});

test('not-equals, an empty type and "at least one" with nothing to meet it', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await person(client, 'admin');
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { conditionalAccessPolicy: 'complete', namedLocation: 'complete' }, policies);
  const off = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'No rule is off', operator: 'not-equals', expected: 'disabled' }), now });
  const none = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'Locations trusted', resourceType: 'namedLocation', field: 'isTrusted', expected: true }), now });
  const missing = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'One trusted location', resourceType: 'namedLocation', field: 'isTrusted', expected: true, appliesTo: 'any' }), now });
  const unread = await createOwnCheck(client, { principalId: admin, tenantRef, input: check({ name: 'Groups', resourceType: 'group', field: 'securityEnabled', expected: true }), now });

  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  const of = (row) => result.evaluations.find((evaluation) => evaluation.control_id === `own.${row.id}`);
  assert.equal(of(off).verdict, 'fail');
  assert.equal(of(off).details[0].expected, 'Anything but disabled');
  assert.equal(of(none).verdict, 'not-applicable', 'no object of the type: nothing to check');
  assert.deepEqual([of(missing).verdict, of(missing).reason], ['fail', 'not-configured']);
  assert.deepEqual([of(unread).verdict, of(unread).reason], ['unknown', 'group:no-observation'], 'a type no backup read is never a guessed pass');
});

test('only someone with configuration writes or removes a check, and a removed one stops', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await person(client, 'admin');
  const operator = await person(client, 'operator');
  const now = new Date();
  await assert.rejects(createOwnCheck(client, { principalId: operator, tenantRef, input: check(), now }), /forbidden/);
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { conditionalAccessPolicy: 'complete' }, policies);
  const row = await createOwnCheck(client, { principalId: admin, tenantRef, input: check(), now });
  await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  assert.equal((await complianceFindings(client, { tenantRef, now })).findings.length, SHIPPED + 1);

  await assert.rejects(removeOwnCheck(client, { principalId: operator, tenantRef, checkId: row.id, now }), /forbidden/);
  assert.equal(await removeOwnCheck(client, { principalId: admin, tenantRef: tenant(), checkId: row.id, now }), null, 'another tenant cannot remove it');
  const removed = await removeOwnCheck(client, { principalId: admin, tenantRef, checkId: row.id, now });
  assert.equal(removed.removed_by, admin);
  assert.equal(await removeOwnCheck(client, { principalId: admin, tenantRef, checkId: row.id, now }), null, 'removing twice does nothing');

  const { findings } = await complianceFindings(client, { tenantRef, now });
  assert.equal(findings.length, SHIPPED, 'a removed check no longer shows');
  assert.equal((await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now })).checked, SHIPPED, 'and no longer runs');
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM benchmark_evaluation WHERE control_id = $1', [`own.${row.id}`]);
  assert.equal(count, 1, 'its past result stays stored');
});

test('a check is refused unless it names a backed-up type, one setting and one plain value', () => {
  assert.equal(validateOwnCheck(check()).expected, 'Enabled');
  assert.throws(() => validateOwnCheck(check({ standard: ' ' })), /standard name/);
  assert.throws(() => validateOwnCheck(check({ name: 'x'.repeat(201) })), /at most 200/);
  assert.throws(() => validateOwnCheck(check({ resourceType: 'exchange-mail-flow' })), /configuration type/);
  assert.throws(() => validateOwnCheck(check({ resourceType: 'nothing' })), /configuration type/);
  for (const field of ['', 'a..b', '@odata.type', 'a.b.c.d.e', 'state; DROP']) {
    assert.throws(() => validateOwnCheck(check({ field })), /one setting/, field);
  }
  for (const expected of [[1], { a: 1 }, 'x'.repeat(201), Number.NaN, undefined]) {
    assert.throws(() => validateOwnCheck(check({ expected })), /plain value/, String(expected));
  }
  assert.equal(validateOwnCheck(check({ expected: null })).expected, null);
  assert.equal(validateOwnCheck(check({ expected: ' enabled ' })).expected, 'enabled', 'text is trimmed');
  assert.throws(() => validateOwnCheck(check({ operator: 'contains' })), /operator/);
  assert.throws(() => validateOwnCheck(check({ appliesTo: 'some' })), /applies to/);
  assert.throws(() => validateOwnCheck(check({ severity: 'urgent' })), /weight/);
});

test('a sensitive field can be neither picked nor checked', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { user: 'complete', conditionalAccessPolicy: 'complete' }, [
    ['user:KEEL-RT-ada', { id: 'u1', displayName: 'KEEL-RT-ada', accountEnabled: true, onPremisesImmutableId: 'secret', employeeId: 'E1' }],
    ...policies,
  ]);
  assert.throws(() => validateOwnCheck(check({ resourceType: 'user', field: 'onPremisesImmutableId', expected: 'x' })), /sensitive/);
  const { types } = await ownCheckChoices(client, { tenantRef });
  const user = types.find((type) => type.resourceType === 'user');
  assert.equal(user.count, 1);
  assert.deepEqual(user.fields.map((entry) => entry.field).filter((field) => ['onPremisesImmutableId', 'employeeId'].includes(field)), []);
  assert.deepEqual(user.fields.find((entry) => entry.field === 'accountEnabled').values, [true]);
  const ca = types.find((type) => type.resourceType === 'conditionalAccessPolicy');
  assert.deepEqual(ca.fields.find((entry) => entry.field === 'state').values, ['enabled', 'disabled']);
  assert.equal(ca.fields.some((entry) => entry.field === 'conditions.clientAppTypes'), false, 'lists are left out');
  assert.equal(ca.fields.some((entry) => entry.field === 'id'), true);
  assert.deepEqual(await ownCheckChoices(client, { tenantRef: tenant() }), { snapshotId: null, types: [] });
});

test('the known standards match their pinned sources and name only real checks', () => {
  const artifact = JSON.parse(readFileSync(new URL('../../docs/release/qualifications/scubagear-benchmark-acceptance.artifact.json', import.meta.url)));
  assert.equal(artifact.commitSha, SCUBA_COMMIT);
  assert.deepEqual([...SCUBA_POLICY_IDS].sort(), artifact.policies.map((policy) => policy.policyId).sort());
  assert.deepEqual(NIST_REFS.map((entry) => [...entry]), NIST_MAPPINGS.map((entry) => [...entry]));
  for (const standard of STANDARDS) {
    assert.equal(new Set(standard.refs.map((entry) => entry.ref)).size, standard.refs.length, standard.id);
    for (const entry of standard.refs) {
      for (const mapped of entry.controls) {
        assert.ok(controlFor(mapped.controlId), `${standard.id} ${entry.ref} names ${mapped.controlId}`);
        assert.ok(['full', 'partial'].includes(mapped.match));
        assert.equal(mapped.match === 'partial', typeof mapped.note === 'string' && mapped.note.length > 0, `${entry.ref}: a partial match says which part`);
      }
    }
  }
  // Public-domain standards only: CIS Benchmarks' licence rules out shipping them.
  assert.deepEqual(STANDARDS.map((standard) => standard.id), ['cisa-scuba', 'nist-800-53']);
});

test('a setting is read from the object itself, and a registered check is never replaced', () => {
  assert.equal(valueAt({ state: 'on' }, 'constructor'), null);
  assert.equal(valueAt({ a: { toString: 1 } }, 'a.toString'), 1);
  assert.equal(valueAt({ a: [1] }, 'a.length'), null);
  const registered = 'keel-custom.conditional-access.block-legacy';
  const fake = { ...controlFromRow({ id: 'x', standard: 's', name: 'n', resource_type: 'conditionalAccessPolicy', field: 'state', operator: 'equals', expected: 'x', applies_to: 'every', severity: 'low' }), controlId: registered };
  assert.throws(() => evaluateControl({ controlId: registered, control: fake, tenantRef: 'sha256:0000000000000000' }), /cannot be replaced/);
});
