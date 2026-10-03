// Roadmap task-71: incident-qualified recovery points and retention pins.
//
// Acceptance:
//  - the most recent compromised snapshot is refused;
//  - an assessment change invalidates promotion;
//  - pinned data survives prune;
//  - an excluded malicious grant is checked after recovery;
//  - a cross-tenant assessment cannot qualify a point.
// Mutation checks:
//  - preferring the newest snapshot regardless of assessment;
//  - pruning incident-pinned data;
//  - omitting exclusions from the fingerprint.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole, revokeRole } from '../authz/administration.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import {
  IncidentAuthorizationError, IncidentRecoveryRefusal, applyIncidentExclusions, assessSnapshot, assessmentFingerprint,
  authorizeRecoveryOverride, evaluatePostRestoreChecks, incidentRecoveryDigestInput, listIncidentRecoveryPoints,
  openIncident, pinSnapshot, qualifyRecoveryPoint, rankRecoveryPoints, recordCompromiseInterval, releasePin,
  resolveIncidentRecovery, revokeRecoveryOverride, valueHash,
} from '../govern/incidents.mjs';
import { computePlanDigest, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { pruneSnapshots } from '../store/retention.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const quiet = { log() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

// Every test runs in its own tenant: an open incident's ongoing compromise interval
// covers every later snapshot of its tenant, which must not leak across tests.
let tenantSeq = 0;
const freshTenant = () => { tenantSeq += 1; return `sha256:task-71-${tenantSeq}-${crypto.randomUUID()}`; };

async function principal(client, role) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${crypto.randomUUID()}@contoso.example`]);
  const grant = role ? await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id }) : null;
  return { id: rows[0].id, grantId: grant?.id ?? null };
}

const board = { displayName: 'Board', mailNickname: 'board', mailEnabled: false, securityEnabled: true, groupTypes: [], description: 'Board members' };
const backdoor = { displayName: 'Helpdesk Tier 0', mailNickname: 'backdoor', mailEnabled: false, securityEnabled: true, groupTypes: [], description: 'granted Global Administrator by the attacker' };

async function seedSnapshot(client, tenantRef, groups, at) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const payload of groups) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: `group:${payload.mailNickname}`, resourceType: 'group', payload, payloadHash: canonicalHash(payload, 'group'),
        criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  // Observation span: a few minutes ending at `at`.
  await client.query(
    `UPDATE snapshot SET started_at = $2::timestamptz - interval '5 minutes', completed_at = $2::timestamptz WHERE id = $1`,
    [snapshotId, at],
  );
  return snapshotId;
}

const row = (fields) => ({ tenant_ref: 'T', ...fields });

// ------------------------------------------------------------- pure qualification

test('only a current, clean, in-scope assessment qualifies a point; compromised is unsuitable, none is unassessed', () => {
  const incident = { id: 'inc-1', tenant_ref: 'T' };
  const intervals = [row({ id: 'w', incident_id: 'inc-1', starts_at: '2026-09-20T00:00:00Z', ends_at: null })];
  const before = row({ id: 'snap-old', started_at: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T00:05:00Z' });
  const during = row({ id: 'snap-new', started_at: '2026-09-25T00:00:00Z', completed_at: '2026-09-25T00:05:00Z' });
  const assess = (snapshot, verdict, extra = {}) => row({
    id: `a-${snapshot.id}`, incident_id: 'inc-1', snapshot_id: snapshot.id, version: 1, verdict, exclusions: [],
    in_compromise_window: snapshot === during, ...extra,
  });

  assert.equal(qualifyRecoveryPoint({ tenantRef: 'T', incident, intervals, snapshot: before }).status, 'unassessed');
  const compromised = qualifyRecoveryPoint({ tenantRef: 'T', incident, intervals, snapshot: during, assessment: assess(during, 'compromised') });
  assert.equal(compromised.status, 'unsuitable');
  assert.equal(compromised.inCompromiseWindow, true);
  const clean = qualifyRecoveryPoint({ tenantRef: 'T', incident, intervals, snapshot: before, assessment: assess(before, 'clean') });
  assert.equal(clean.status, 'qualified');
  assert.equal(clean.assessment.fingerprint, assessmentFingerprint(clean.assessment));

  // A collection that spans the interval start is in the window: an observation is
  // a time span, never one atomic instant.
  const spanning = row({ id: 'snap-span', started_at: '2026-09-19T23:58:00Z', completed_at: '2026-09-20T00:03:00Z' });
  assert.equal(qualifyRecoveryPoint({ tenantRef: 'T', incident, intervals, snapshot: spanning }).inCompromiseWindow, true);

  // The window moved across an assessed snapshot after it was assessed: stale.
  const moved = [row({ id: 'w2', incident_id: 'inc-1', starts_at: '2026-09-05T00:00:00Z', ends_at: null })];
  const stale = qualifyRecoveryPoint({ tenantRef: 'T', incident, intervals: moved, snapshot: before, assessment: assess(before, 'clean') });
  assert.equal(stale.status, 'unassessed');
  assert.equal(stale.stale, true);
  assert.match(stale.reasons.join(' '), /reassess/);
});

test('cross-tenant: an assessment from another tenant, incident or snapshot can never qualify a point', () => {
  const incident = { id: 'inc-1', tenant_ref: 'T' };
  const snapshot = row({ id: 'snap', started_at: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T00:05:00Z' });
  const clean = { id: 'a', incident_id: 'inc-1', snapshot_id: 'snap', version: 1, verdict: 'clean', exclusions: [], in_compromise_window: false };
  for (const foreign of [
    { ...clean, tenant_ref: 'OTHER' },
    { ...clean, tenant_ref: 'T', incident_id: 'inc-other' },
    { ...clean, tenant_ref: 'T', snapshot_id: 'snap-other' },
  ]) {
    const point = qualifyRecoveryPoint({ tenantRef: 'T', incident, snapshot, assessment: foreign });
    assert.equal(point.status, 'unassessed', JSON.stringify(foreign));
    assert.equal(point.assessment, null);
  }
  assert.throws(() => qualifyRecoveryPoint({ tenantRef: 'T', incident: { id: 'inc-1', tenant_ref: 'OTHER' }, snapshot }), IncidentRecoveryRefusal);
  assert.throws(() => qualifyRecoveryPoint({ tenantRef: 'T', incident, snapshot: { ...snapshot, tenant_ref: 'OTHER' } }), IncidentRecoveryRefusal);
});

test('mutation check: the recommended point is the newest QUALIFIED one, never simply the newest', () => {
  const ranked = rankRecoveryPoints([
    { snapshotId: 'oldest', observedTo: '2026-09-01T00:00:00Z', status: 'qualified' },
    { snapshotId: 'newest', observedTo: '2026-09-29T00:00:00Z', status: 'unsuitable' },
    { snapshotId: 'middle', observedTo: '2026-09-15T00:00:00Z', status: 'qualified' },
    { snapshotId: 'recent', observedTo: '2026-09-25T00:00:00Z', status: 'unassessed' },
  ]);
  assert.deepEqual(ranked.points.map((p) => p.snapshotId), ['newest', 'recent', 'middle', 'oldest']);
  assert.equal(ranked.recommended, 'middle');
  assert.equal(rankRecoveryPoints([{ snapshotId: 'n', observedTo: '2026-09-29T00:00:00Z', status: 'unsuitable' }]).recommended, null);
});

test('mutation check: exclusions are part of the assessment fingerprint and of the plan digest', () => {
  const base = { incidentId: 'i', snapshotId: 's', version: 3, verdict: 'clean', inCompromiseWindow: false };
  const none = assessmentFingerprint({ ...base, exclusions: [] });
  const one = assessmentFingerprint({ ...base, exclusions: [{ naturalKey: 'group:backdoor', field: null, reason: 'attacker group' }] });
  const field = assessmentFingerprint({ ...base, exclusions: [{ naturalKey: 'group:board', field: 'description', reason: 'defaced' }] });
  assert.notEqual(none, one);
  assert.notEqual(one, field);
  // Order-independent: the same set is the same fingerprint.
  const a = { naturalKey: 'group:a', field: null, reason: 'x' };
  const b = { naturalKey: 'group:b', field: 'description', reason: 'y' };
  assert.equal(assessmentFingerprint({ ...base, exclusions: [a, b] }), assessmentFingerprint({ ...base, exclusions: [b, a] }));

  const plan = (exclusions) => computePlanDigest({
    snapshotId: 's', selection: ['group:board'], closureKeys: ['group:board'], targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r',
    reconciliationResources: null, waves: [['group:board']], patches: [],
    incidentRecovery: incidentRecoveryDigestInput({
      incidentId: 'i', snapshotId: 's', status: 'qualified', qualification: 'qualified', inCompromiseWindow: false,
      assessment: { id: 'a', version: 3, verdict: 'clean', fingerprint: 'f' }, exclusions, override: null, postRestoreChecks: [],
    }),
  });
  assert.notEqual(plan([]), plan([a]));
});

test('exclusions: a whole malicious resource in the closure refuses; a field exclusion is not written and becomes a check', () => {
  const resources = [
    { naturalKey: 'group:board', resourceType: 'group', payload: { ...board, description: 'pwned' }, payloadHash: 'x' },
  ];
  assert.throws(
    () => applyIncidentExclusions([...resources, { naturalKey: 'group:backdoor', resourceType: 'group', payload: backdoor }],
      [{ naturalKey: 'group:backdoor', field: null, reason: 'attacker group' }], { hash: canonicalHash }),
    /closure includes group:backdoor, excluded as malicious/,
  );
  const { resources: out, checks } = applyIncidentExclusions(resources, [
    { naturalKey: 'group:board', field: 'description', reason: 'defaced' },
    { naturalKey: 'group:backdoor', field: null, reason: 'attacker group' },
  ], { hash: canonicalHash });
  assert.equal(Object.hasOwn(out[0].payload, 'description'), false);
  assert.equal(out[0].payloadHash, canonicalHash(out[0].payload, 'group'));
  assert.equal(resources[0].payload.description, 'pwned', 'the snapshot resource is never mutated');
  assert.deepEqual(checks.map((c) => [c.naturalKey, c.field, c.expectation]), [
    ['group:backdoor', null, 'absent'], ['group:board', 'description', 'not-equal'],
  ]);
  assert.equal(checks[1].valueHash, valueHash('pwned'));

  const results = evaluatePostRestoreChecks(checks, [
    { naturalKey: 'group:board', payload: { ...board, description: 'pwned' } },
    { naturalKey: 'group:backdoor', payload: backdoor },
  ]);
  assert.deepEqual(results.map((r) => r.outcome), ['failed', 'failed']);
  const cleanResults = evaluatePostRestoreChecks(checks, [{ naturalKey: 'group:board', resourceType: 'group', payload: board }]);
  assert.deepEqual(cleanResults.map((r) => r.outcome), ['passed', 'passed']);
  // Absence from a read that does not cover the type proves nothing: unverified, never passed.
  const uncovered = evaluatePostRestoreChecks(checks, []);
  assert.deepEqual(uncovered.map((r) => r.outcome), ['unverified', 'unverified']);
  assert.deepEqual(evaluatePostRestoreChecks(checks, [], { collectedTypes: ['group'] }).map((r) => r.outcome), ['passed', 'passed']);
});

// ---------------------------------------------------- authorization and pins

test('only a principal currently holding investigate can open incidents, assess, override or pin', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const investigator = await principal(client, 'investigator');
  const approver = await principal(client, 'approver');
  const snapshotId = await seedSnapshot(client, tenantRef, [board], daysAgo(2));

  await assert.rejects(openIncident(client, { tenantRef, title: 'x', actorId: approver.id }), IncidentAuthorizationError);
  await assert.rejects(openIncident(client, { tenantRef, title: 'x', actorId: undefined }), IncidentAuthorizationError);
  const incident = await openIncident(client, { tenantRef, title: 'Token theft', actorId: investigator.id });
  assert.equal(incident.owner, investigator.id);
  for (const call of [
    () => assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId, verdict: 'clean', rationale: 'r', actorId: approver.id }),
    () => pinSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId, reason: 'r', actorId: approver.id }),
    () => recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: daysAgo(1), reason: 'r', actorId: approver.id }),
  ]) await assert.rejects(call(), IncidentAuthorizationError);

  // A revoked grant is re-checked on the very next write.
  await revokeRole(client, { principalId: investigator.id, grantId: investigator.grantId, revokedBy: investigator.id });
  await assert.rejects(pinSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId, reason: 'r', actorId: investigator.id }), IncidentAuthorizationError);

  // Every transition is on the evidence chain.
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'incident-recovery'`, [tenantRef]);
  assert.deepEqual(rows.map((r) => r.subject.transition), ['incident-opened']);
});

test('mutation check: incident-pinned data survives prune until an authorized release; a pin never qualifies a point', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const investigator = await principal(client, 'investigator');
  const old = await seedSnapshot(client, tenantRef, [board], daysAgo(30));
  const other = await seedSnapshot(client, tenantRef, [board], daysAgo(29));
  const incident = await openIncident(client, { tenantRef, title: 'Pinned', actorId: investigator.id });
  const pin = await pinSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: old, reason: 'last known good', actorId: investigator.id });
  await assert.rejects(pinSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: old, reason: 'again', actorId: investigator.id }), /already pinned/);

  // Pin existence is not evidence of a clean state.
  const { point } = await import('../govern/incidents.mjs').then((m) => m.qualifySnapshotForIncident(client, { tenantRef, incidentId: incident.id, snapshotId: old }));
  assert.equal(point.status, 'unassessed');

  const pruned = await pruneSnapshots(client, { tenantRef, now: new Date().toISOString() });
  assert.deepEqual(pruned, [other], 'only the unpinned snapshot is pruned (tier1 retention is 7 days)');
  const { rows: survivors } = await client.query('SELECT count(*)::int AS n FROM resource_version WHERE snapshot_id = $1', [old]);
  assert.equal(survivors[0].n, 1, 'the pinned snapshot keeps its resource versions');

  const approver = await principal(client, 'approver');
  await assert.rejects(releasePin(client, { tenantRef, pinId: pin.id, reason: 'done', actorId: approver.id }), IncidentAuthorizationError);
  await assert.rejects(releasePin(client, { tenantRef, pinId: pin.id, reason: ' ', actorId: investigator.id }), /reason is required/);
  await assert.rejects(releasePin(client, { tenantRef: freshTenant(), pinId: pin.id, reason: 'x', actorId: investigator.id }), /active pin not found/);
  const released = await releasePin(client, { tenantRef, pinId: pin.id, reason: 'incident closed', actorId: investigator.id });
  assert.equal(released.releasedBy, investigator.id);

  // Released: routine retention applies again, and the pin history does not block it.
  assert.deepEqual(await pruneSnapshots(client, { tenantRef, now: new Date().toISOString() }), [old]);
  const { rows: history } = await client.query('SELECT released_at FROM retention_pin WHERE id = $1', [pin.id]);
  assert.ok(history[0].released_at);
});

test('cross-tenant: another tenant cannot assess, pin or qualify this tenant\'s snapshot', async (t) => {
  const client = await schemaClient(t);
  const tenantA = freshTenant();
  const tenantB = freshTenant();
  const investigator = await principal(client, 'investigator');
  const snapA = await seedSnapshot(client, tenantA, [board], daysAgo(3));
  const incidentA = await openIncident(client, { tenantRef: tenantA, title: 'A', actorId: investigator.id });
  const incidentB = await openIncident(client, { tenantRef: tenantB, title: 'B', actorId: investigator.id });

  await assert.rejects(assessSnapshot(client, { tenantRef: tenantB, incidentId: incidentB.id, snapshotId: snapA, verdict: 'clean', rationale: 'r', actorId: investigator.id }), /snapshot not found/);
  await assert.rejects(pinSnapshot(client, { tenantRef: tenantB, incidentId: incidentB.id, snapshotId: snapA, reason: 'r', actorId: investigator.id }), /snapshot not found/);
  await assert.rejects(assessSnapshot(client, { tenantRef: tenantB, incidentId: incidentA.id, snapshotId: snapA, verdict: 'clean', rationale: 'r', actorId: investigator.id }), /incident not found/);

  // A forged row in another tenant, naming tenant A's incident and snapshot, is ignored.
  await client.query(
    `INSERT INTO incident_snapshot_assessment (tenant_ref, incident_id, snapshot_id, version, verdict, exclusions, in_compromise_window, rationale, assessed_by)
     VALUES ($1, $2, $3, 99, 'clean', '[]', false, 'forged', $4)`,
    [tenantB, incidentA.id, snapA, investigator.id],
  );
  const listing = await listIncidentRecoveryPoints(client, { tenantRef: tenantA, incidentId: incidentA.id });
  assert.equal(listing.points.find((p) => p.snapshotId === snapA).status, 'unassessed');
  await assert.rejects(resolveIncidentRecovery(client, { tenantRef: tenantA, incidentId: incidentA.id, snapshotId: snapA }), /is unassessed/);
  await assert.rejects(resolveIncidentRecovery(client, { tenantRef: tenantA, incidentId: incidentB.id, snapshotId: snapA }), /incident .* not found for this tenant/);
  await assert.rejects(listIncidentRecoveryPoints(client, { tenantRef: tenantB, incidentId: incidentA.id }), /incident not found/);
});

// ------------------------------------------------------ full restore path (CLI)

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-71', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-71', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

function groupsOf(graph) {
  return [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body);
}

function cliDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/groups')) return { items: groupsOf(graph), capped: false, error: null };
      return { items: [], capped: false, error: null };
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
      ...groupsOf(graph).map((group) => ({
        naturalKey: `group:${group.mailNickname}`, resourceType: 'group', sourceId: group.id, payload: group,
      })),
    ],
  };
}

const run = (graph, options) => runRestore({
  readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet, ...options,
});
const dryRun = (graph, { snapshotId, selection = ['group:board'], incidentId, artifactId = crypto.randomUUID(), requestedBy }) => run(graph, {
  snapshotId, selection, incidentId, mode: 'dry-run', persistArtifactId: artifactId, requestedBy,
  collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
  collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
}).then((result) => ({ ...result, artifactId }));
const promote = (graph, artifactId) => run(graph, { artifactId, mode: 'enforce' });

/** A compromise: the board group was defaced and a backdoor group added. The last
 * known-good snapshot is 10 days old; the newest one (1 day) captured the attack. */
async function compromisedTenant(client) {
  const tenantRef = freshTenant();
  const investigator = await principal(client, 'investigator');
  const requester = await principal(client, 'restorer');
  const good = await seedSnapshot(client, tenantRef, [board], daysAgo(10));
  const bad = await seedSnapshot(client, tenantRef, [{ ...board, description: 'pwned' }, backdoor], daysAgo(1));
  const incident = await openIncident(client, { tenantRef, title: 'Admin consent phishing', actorId: investigator.id });
  await recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: daysAgo(3), reason: 'first malicious sign-in', actorId: investigator.id });
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: bad, verdict: 'compromised', rationale: 'captures the backdoor group', actorId: investigator.id });
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: good, verdict: 'clean', rationale: 'before first malicious sign-in', actorId: investigator.id });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, description: 'pwned', id: 'board-id' });
  return { tenantRef, investigator, requester, good, bad, incident, graph };
}

test('the most recent compromised snapshot is refused; the qualified point is recommended and restores', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, requester, good, bad, incident, graph } = await compromisedTenant(client);

  const listing = await listIncidentRecoveryPoints(client, { tenantRef, incidentId: incident.id });
  assert.deepEqual(listing.points.map((p) => [p.snapshotId, p.status]), [[bad, 'unsuitable'], [good, 'qualified']]);
  assert.equal(listing.recommended, good);

  // Under the incident: refused, nothing persisted, nothing written.
  const refusedId = crypto.randomUUID();
  await assert.rejects(dryRun(graph, { snapshotId: bad, incidentId: incident.id, artifactId: refusedId, requestedBy: requester.id }), /incident-recovery-refused: snapshot .* is unsuitable/);
  assert.equal(await getDryRunArtifactById(client, { id: refusedId }), null);
  // Without naming the incident: the gate cannot be sidestepped.
  await assert.rejects(dryRun(graph, { snapshotId: bad, requestedBy: requester.id }), /lies in a compromise interval of open incident/);

  const dry = await dryRun(graph, { snapshotId: good, incidentId: incident.id, requestedBy: requester.id });
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  assert.equal(artifact.status, 'completed', JSON.stringify(artifact.results));
  assert.equal(artifact.incidentRecovery.incidentId, incident.id);
  assert.equal(artifact.incidentRecovery.qualification, 'qualified');
  assert.equal(artifact.incidentRecovery.assessment.version, 1);
  assert.equal(graph.writes.length, 0, 'a dry run writes nothing');

  const result = await promote(graph, dry.artifactId);
  assert.equal(graph.objects.get('/groups/board-id').description, 'Board members');
  assert.deepEqual(result.incidentChecks, []);
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'incident-recovery-check'`, [tenantRef]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject.artifactId, dry.artifactId);
});

test('an assessment change after review invalidates promotion', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, investigator, requester, good, incident, graph } = await compromisedTenant(client);
  const dry = await dryRun(graph, { snapshotId: good, incidentId: incident.id, requestedBy: requester.id });

  // Same verdict, new version (a re-review): the bound fingerprint no longer matches.
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: good, verdict: 'clean', rationale: 're-reviewed', actorId: investigator.id });
  await assert.rejects(promote(graph, dry.artifactId), /restore promotion refused: the recomputed restore plan no longer matches/);

  // Reassessed compromised: refused outright.
  const second = await dryRun(graph, { snapshotId: good, incidentId: incident.id, requestedBy: requester.id });
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: good, verdict: 'compromised', rationale: 'persistence found earlier', actorId: investigator.id });
  await assert.rejects(promote(graph, second.artifactId), /restore promotion refused: incident-recovery-refused/);

  // An assessment row tampered in place (exclusions edited, same version) changes the fingerprint too.
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: good, verdict: 'clean', rationale: 'cleared', actorId: investigator.id });
  const third = await dryRun(graph, { snapshotId: good, incidentId: incident.id, requestedBy: requester.id });
  await client.query(
    `UPDATE incident_snapshot_assessment SET exclusions = '[{"naturalKey":"group:board","field":"description","reason":"edited"}]'
      WHERE incident_id = $1 AND snapshot_id = $2 AND version = (SELECT max(version) FROM incident_snapshot_assessment WHERE incident_id = $1 AND snapshot_id = $2)`,
    [incident.id, good],
  );
  await assert.rejects(promote(graph, third.artifactId), /restore promotion refused/);

  // A compromise interval moved across the point after review: the assessment is stale.
  await client.query(`UPDATE incident_snapshot_assessment SET exclusions = '[]' WHERE incident_id = $1 AND snapshot_id = $2`, [incident.id, good]);
  const fourth = await dryRun(graph, { snapshotId: good, incidentId: incident.id, requestedBy: requester.id });
  await recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: daysAgo(12), endsAt: daysAgo(9), reason: 'earlier foothold', actorId: investigator.id });
  await assert.rejects(promote(graph, fourth.artifactId), /restore promotion refused: incident-recovery-refused/);

  assert.equal(graph.writes.length, 0, 'no refused promotion wrote anything');
});

test('an excluded malicious grant is checked after recovery: still live fails the run visibly, removed passes', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const investigator = await principal(client, 'investigator');
  const requester = await principal(client, 'restorer');
  // Only one snapshot exists and it already captured the backdoor: the investigator
  // clears it with the backdoor group and the defaced description excluded.
  const snap = await seedSnapshot(client, tenantRef, [{ ...board, description: 'pwned' }, backdoor], daysAgo(1));
  const incident = await openIncident(client, { tenantRef, title: 'Backdoor', actorId: investigator.id });
  await recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: daysAgo(2), reason: 'r', actorId: investigator.id });
  await assert.rejects(assessSnapshot(client, {
    tenantRef, incidentId: incident.id, snapshotId: snap, verdict: 'clean', rationale: 'r', actorId: investigator.id,
    exclusions: [{ naturalKey: 'group:not-there', field: null, reason: 'x' }],
  }), /not in this snapshot/);
  await assessSnapshot(client, {
    tenantRef, incidentId: incident.id, snapshotId: snap, verdict: 'clean', rationale: 'everything else predates the attacker', actorId: investigator.id,
    exclusions: [
      { naturalKey: 'group:backdoor', field: null, reason: 'attacker-created group granted Global Administrator' },
      { naturalKey: 'group:board', field: 'description', reason: 'defaced by the attacker' },
    ],
  });

  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, displayName: 'Board (renamed)', description: 'pwned', id: 'board-id' });
  graph.objects.set('/groups/backdoor-id', { ...backdoor, id: 'backdoor-id' });

  // Selecting the excluded grant itself is refused.
  await assert.rejects(dryRun(graph, { snapshotId: snap, selection: ['group:backdoor'], incidentId: incident.id, requestedBy: requester.id }), /excluded as malicious/);

  const dry = await dryRun(graph, { snapshotId: snap, incidentId: incident.id, requestedBy: requester.id });
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  assert.deepEqual(artifact.incidentRecovery.postRestoreChecks.map((c) => [c.naturalKey, c.field, c.expectation]), [
    ['group:backdoor', null, 'absent'], ['group:board', 'description', 'not-equal'],
  ]);

  // The restore writes the rest of the board group but never the defaced field; the
  // backdoor group and the defacement are still live, so the checks fail the run.
  await assert.rejects(promote(graph, dry.artifactId), /incident-check-failed: excluded malicious resource group:backdoor is present .*excluded malicious value is live at group:board description/);
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board');
  const patches = graph.writes.filter((w) => w.method === 'PATCH');
  assert.equal(patches.length, 1);
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'incident-recovery-check' ORDER BY seq`, [tenantRef]);
  assert.deepEqual(rows[0].subject.checks.map((c) => c.outcome), ['failed', 'failed']);

  // The operator removes the backdoor and fixes the description: a fresh recovery passes.
  graph.objects.delete('/groups/backdoor-id');
  graph.objects.set('/groups/board-id', { ...graph.objects.get('/groups/board-id'), displayName: 'Board (renamed)', description: 'Board members' });
  const again = await dryRun(graph, { snapshotId: snap, incidentId: incident.id, requestedBy: requester.id });
  const result = await promote(graph, again.artifactId);
  assert.deepEqual(result.incidentChecks.map((c) => c.outcome), ['passed', 'passed']);
});

test('an unsuitable or unassessed point needs an investigator override with a reason, bound to the assessment, re-checked at promotion', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, investigator, requester, bad, incident, graph } = await compromisedTenant(client);
  const reviewer = await principal(client, 'investigator');

  await assert.rejects(authorizeRecoveryOverride(client, { tenantRef, incidentId: incident.id, snapshotId: bad, reason: '', actorId: investigator.id }), /reason is required/);
  const unprivileged = await principal(client, 'restorer');
  await assert.rejects(authorizeRecoveryOverride(client, { tenantRef, incidentId: incident.id, snapshotId: bad, reason: 'r', actorId: unprivileged.id }), IncidentAuthorizationError);

  // The requester's own override never counts.
  const self = await authorizeRecoveryOverride(client, { tenantRef, incidentId: incident.id, snapshotId: bad, reason: 'self', actorId: investigator.id });
  await assert.rejects(dryRun(graph, { snapshotId: bad, selection: ['group:board'], incidentId: incident.id, requestedBy: investigator.id }), /is unsuitable/);
  await revokeRecoveryOverride(client, { tenantRef, overrideId: self.id, actorId: investigator.id });

  const override = await authorizeRecoveryOverride(client, {
    tenantRef, incidentId: incident.id, snapshotId: bad, reason: 'only point with the new board membership; backdoor handled manually', actorId: reviewer.id,
  });
  const dry = await dryRun(graph, { snapshotId: bad, selection: ['group:board'], incidentId: incident.id, requestedBy: requester.id });
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  assert.equal(artifact.incidentRecovery.qualification, 'overridden');
  assert.equal(artifact.incidentRecovery.override.authorizedBy, reviewer.id);
  assert.match(artifact.incidentRecovery.override.reason, /only point/);

  // The authorizer loses investigate before promotion: refused.
  await revokeRole(client, { principalId: reviewer.id, grantId: reviewer.grantId, revokedBy: reviewer.id });
  await assert.rejects(promote(graph, dry.artifactId), /restore promotion refused: incident-recovery-refused/);
  await revokeRecoveryOverride(client, { tenantRef, overrideId: override.id, actorId: investigator.id });

  // An override is bound to the assessment state it was made against.
  const third = await principal(client, 'investigator');
  await authorizeRecoveryOverride(client, { tenantRef, incidentId: incident.id, snapshotId: bad, reason: 'r', actorId: third.id });
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: bad, verdict: 'compromised', rationale: 'reconfirmed', actorId: investigator.id });
  await assert.rejects(dryRun(graph, { snapshotId: bad, selection: ['group:board'], incidentId: incident.id, requestedBy: requester.id }), /is unsuitable/);
  assert.equal(graph.writes.length, 0);
});

test('a promotion refuses when an incident now covers its snapshot, and incident flags are validated', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const investigator = await principal(client, 'investigator');
  const snap = await seedSnapshot(client, tenantRef, [board], daysAgo(1));
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, description: 'changed', id: 'board-id' });
  const dry = await dryRun(graph, { snapshotId: snap, requestedBy: 'requester' });
  assert.equal(dry.incidentRecovery, null);

  // An incident opened after review whose window covers the snapshot blocks the promotion.
  const incident = await openIncident(client, { tenantRef, title: 'Late detection', actorId: investigator.id });
  await recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: daysAgo(5), reason: 'r', actorId: investigator.id });
  await assert.rejects(promote(graph, dry.artifactId), /restore promotion refused: incident-recovery-refused: .*lies in a compromise interval/);
  assert.equal(graph.writes.length, 0);

  const cli = (argv) => main({ argv: ['node', 'keel-restore.mjs', ...argv], readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet });
  await assert.rejects(cli(['--artifact', dry.artifactId, '--enforce', '--incident', incident.id]), /mutually exclusive|--incident requires/);
  await assert.rejects(cli(['--compensate', dry.artifactId, '--incident', incident.id]), /mutually exclusive/);
  await assert.rejects(run(graph, { artifactId: dry.artifactId, mode: 'enforce', incidentId: incident.id }), /supplied by the dry-run artifact/);
  await assert.rejects(run(graph, { planId: 'p', mode: 'dry-run', incidentId: incident.id }), /requires the snapshotId\/selection restore scope/);
});

test('the worker carries only the incident id into a selection dry run', () => {
  const base = { collectorConfig: '/c.json', targetConfig: '/r.json', snapshotId: 's', selection: ['group:board'], artifactId: 'a' };
  const args = JOB_HANDLERS.restore.argsFor({ ...base, incidentId: 'inc-1' }, { requested_by: 'p' });
  assert.deepEqual(args.slice(args.indexOf('--incident'), args.indexOf('--incident') + 2), ['--incident', 'inc-1']);
  assert.throws(() => JOB_HANDLERS.restore.argsFor({ collectorConfig: '/c', targetConfig: '/r', planId: 'p', incidentId: 'inc-1' }), /requires the snapshot\/selection scope/);
  // A promotion never carries one: its incident comes from the artifact.
  assert.deepEqual(JOB_HANDLERS.restore.argsFor({ artifactId: 'a', mode: 'enforce' }), ['--artifact', 'a', '--enforce']);
});
