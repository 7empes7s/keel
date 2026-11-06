/**
 * Roadmap task-124 boundary tests: the release sign-off and its recapture plan
 * (tools/release/readiness.mjs signoff | recapture-plan).
 *
 * The sign-off judges one candidate build. A record counts only when it is
 * fresh, from that build and verifies; manual routes are listed as manual; the
 * deferred hybrid runtime is never shipped. Nothing here touches a tenant: the
 * synthetic cases write records into a temp dir and stand in for verifyEvidence.
 *
 * Required mutation checks (each makes a test below fail):
 *
 * - Ignore missing external qualification.  ('a missing record holds ready')
 * - Count manual handoff as automated recovery. ('manual routes are never automated')
 * - Label deferred runtime shipped.          ('the deferred hybrid runtime never ships')
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { HYBRID_RUNTIME } from '../contracts/topology.mjs';
import { buildOperationLedger } from '../coverage/qualification.mjs';
import { RELEASE_OBJECTIVES } from '../../tools/release/acceptanceLedger.mjs';
import { buildRelation, gitChangedPaths } from '../../tools/release/qualification.mjs';
import { ENTRA_LIVE_GATE, ENTRA_LIVE_KIND, TEST_TENANT_REFS } from '../../tools/qualification/entraLive.mjs';
import {
  GATE_STATES, REPO_ROOT, buildRecapturePlan, buildReleaseSignoff, classifyEntraAtBuild, classifyRecordAtBuild, deferredScope, recoveryRoutes,
  releaseGateInventory, renderSignoffMarkdown, writeFamilyCoverage,
} from '../../tools/release/readiness.mjs';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const B = 'c0ffee0000000000000000000000000000000000';
const OTHER = 'deadbeef00000000000000000000000000000000';
const HOUR = 60 * 60 * 1000;
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const passedJourneys = { evidenceLevel: 'fixture-tested', build: B, journeys: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'].map((journey) => ({ journey, outcome: 'passed' })) };
const okVerify = () => ({ ok: true, failures: [] });
const entraQualified = () => ({ state: 'live-qualified', build: B, observedAt: hoursAgo(1), ageDays: 0, reasons: [] });
const ENTRA_OPS = [{ resourceType: 'group', operation: 'update' }];

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function record(gate, overrides = {}) {
  return { contractVersion: 1, gate, tenantRef: 'sha256:test', build: B, operation: 'op', credentialMode: 'mode',
    observedAt: hoursAgo(1), evidenceLevel: 'live-qualified', synthetic: false, subject: {}, proof: {}, ...overrides };
}

/** A temp qualifications dir with a fresh, candidate-build record for every gate (sentinel stays a placeholder). */
function fullDir(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-signoff-'));
  dirs.push(dir);
  for (const entry of releaseGateInventory()) {
    const value = entry.acceptedGap ? { gate: entry.gate, status: 'pending', evidenceLevel: 'fixture-tested', synthetic: true } : record(entry.gate);
    const edited = edit(entry, value);
    if (edited !== null) writeFileSync(join(dir, entry.file), JSON.stringify(edited ?? value));
  }
  return dir;
}

const signoff = (dir, overrides = {}) => buildReleaseSignoff({
  dir, fixture: passedJourneys, candidateBuild: B, hmacKey: 'test-key', tenantRef: 'sha256:test', now: NOW,
  verify: okVerify, entraOperations: ENTRA_OPS, classifyEntra: entraQualified, objectiveGapsAccepted: true, ...overrides,
});

test('a complete, fresh, candidate-build record set signs off ready (ready is reachable)', () => {
  const report = signoff(fullDir());
  assert.equal(report.verdict, 'ready', report.reasons.join('\n'));
  assert.deepEqual(report.reasons, []);
  assert.ok(report.gates.every((gate) => gate.state === 'live-qualified' || gate.acceptedGap));
});

test('a missing record holds ready, and the recapture plan names it', () => {
  const dir = fullDir((entry) => (entry.gate === 'native-live-acceptance' ? null : undefined));
  const report = signoff(dir);
  assert.equal(report.verdict, 'pending');
  const native = report.gates.find((gate) => gate.id === 'native-live-acceptance');
  assert.equal(native.state, 'missing');
  assert.equal(native.record, null);
  assert.ok(report.reasons.some((reason) => reason.startsWith('native-live-acceptance is missing')));
  assert.equal(report.objectives.find((o) => o.id === 'D2').liveQualified.status, 'not-live-qualified');
  const plan = buildRecapturePlan(report);
  const row = plan.gates.find((gate) => gate.id === 'native-live-acceptance');
  assert.ok(row, 'the missing gate is in the recapture plan');
  assert.match(row.capture, /nativeRecovery\.mjs capture/);
  assert.match(row.verify, /--gate native-live-acceptance/);
});

test('a missing workload record (not only a ledger gate) also holds ready', () => {
  const report = signoff(fullDir((entry) => (entry.id === 'workload-reads-live-acceptance:teams-meeting-settings' ? null : undefined)));
  assert.equal(report.verdict, 'pending');
  assert.ok(buildRecapturePlan(report).gates.some((gate) => gate.id === 'workload-reads-live-acceptance:teams-meeting-settings'));
});

test('no candidate build, no key or no tenant: unverified, never ready', () => {
  const dir = fullDir();
  for (const overrides of [{ candidateBuild: null }, { hmacKey: null }, { tenantRef: null }]) {
    const report = signoff(dir, overrides);
    assert.equal(report.verdict, 'pending');
    assert.ok(report.gates.filter((gate) => !gate.acceptedGap).every((gate) => gate.state === 'unverified'));
  }
});

test('stale evidence: 7 days for deployed acceptance, 30 days for the rest', () => {
  const at = (gate, hours) => fullDir((entry, value) => (entry.gate === gate ? { ...value, observedAt: hoursAgo(hours) } : undefined));
  assert.equal(signoff(at('deployed-acceptance', 6 * 24)).verdict, 'ready');
  const deployed = signoff(at('deployed-acceptance', 8 * 24));
  assert.equal(deployed.verdict, 'pending');
  assert.equal(deployed.gates.find((gate) => gate.id === 'deployed-acceptance').state, 'stale');
  assert.equal(signoff(at('storage-live-acceptance', 29 * 24)).verdict, 'ready');
  const storage = signoff(at('storage-live-acceptance', 31 * 24));
  assert.equal(storage.gates.find((gate) => gate.id === 'storage-live-acceptance').state, 'stale');
  assert.ok(buildRecapturePlan(storage).gates.some((gate) => gate.id === 'storage-live-acceptance' && gate.state === 'stale'));
});

test('a record from another build is recaptured, even if the verifier would accept it', () => {
  const dir = fullDir((entry, value) => (entry.gate === 'teams-live-acceptance' ? { ...value, build: OTHER } : undefined));
  const report = signoff(dir);
  assert.equal(report.verdict, 'pending');
  const teams = report.gates.find((gate) => gate.id === 'teams-live-acceptance');
  assert.equal(teams.state, 'other-build');
  assert.equal(teams.build, OTHER);
  assert.ok(buildRecapturePlan(report).gates.some((gate) => gate.id === 'teams-live-acceptance'));
});

// --- Issue #1044: records-only commits keep the build ----------------------

/** A throwaway git repo: C (code), C' = C + records and docs only, C'' = C' + an engine change, R = C' + an engine file moved into docs. */
function repoWithCommits() {
  const repo = mkdtempSync(join(tmpdir(), 'keel-signoff-git-'));
  dirs.push(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  const put = (file, text) => { mkdirSync(join(repo, file, '..'), { recursive: true }); writeFileSync(join(repo, file), text); };
  const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  put('engine/restore/writer.mjs', 'export const v = 1;\n');
  put('docs/coverage.md', 'v1\n');
  const C = commit('code');
  put('docs/release/qualifications/teams-live-acceptance.json', '{}\n');
  put('lessons/2026-11-06-records.md', 'lesson\n');
  put('ops/STATE.md', 'state\n');
  const recordsOnly = commit('records only');
  put('engine/restore/writer.mjs', 'export const v = 2;\n');
  const codeChange = commit('engine fix');
  git('reset', '-q', '--hard', recordsOnly);
  renameSync(join(repo, 'engine/restore/writer.mjs'), join(repo, 'docs/writer.mjs'));
  const moved = commit('engine file moved under docs');
  return { C, recordsOnly, codeChange, moved, changedPaths: (from, to) => gitChangedPaths(from, to, { cwd: repo }) };
}

test('a record at C counts at C\' when C..C\' touches only docs, lessons and ops/STATE.md, reported as same-code', () => {
  const { C, recordsOnly, changedPaths } = repoWithCommits();
  assert.deepEqual(buildRelation(C, recordsOnly, { changedPaths }), { relation: 'same-code', range: `${C.slice(0, 10)}..${recordsOnly.slice(0, 10)}` });
  const calls = [];
  const report = signoff(fullDir((entry, value) => ({ ...value, build: C })), {
    candidateBuild: recordsOnly, changedPaths, verify: (value, options) => { calls.push(options); return { ok: true, failures: [] }; },
  });
  assert.equal(report.verdict, 'ready', report.reasons.join('\n'));
  const teams = report.gates.find((gate) => gate.id === 'teams-live-acceptance');
  assert.equal(teams.state, 'live-qualified');
  assert.equal(teams.build, C);
  assert.deepEqual(teams.sameCode, { range: `${C.slice(0, 10)}..${recordsOnly.slice(0, 10)}` });
  // Verified at the build the record names; deployed acceptance may see a records-only descendant deployed.
  assert.ok(calls.every((call) => call.build === C));
  assert.equal(calls[0].sameCode(recordsOnly, C), true);
  assert.match(renderSignoffMarkdown(report), new RegExp(`same code: ${C.slice(0, 10)}\\.\\.${recordsOnly.slice(0, 10)}`));
});

test('a record at C is other-build at a candidate whose range touches engine/, or moves code under docs/', () => {
  const { C, codeChange, moved, changedPaths } = repoWithCommits();
  for (const candidateBuild of [codeChange, moved]) {
    assert.equal(buildRelation(C, candidateBuild, { changedPaths }).relation, 'other-build');
    const report = signoff(fullDir((entry, value) => (entry.gate === 'teams-live-acceptance' ? { ...value, build: C } : { ...value, build: candidateBuild })),
      { candidateBuild, changedPaths });
    assert.equal(report.verdict, 'pending');
    const teams = report.gates.find((gate) => gate.id === 'teams-live-acceptance');
    assert.equal(teams.state, 'other-build');
    assert.equal(teams.sameCode, null);
  }
  // An unknown commit, or a build that is not a commit id, is never the same code.
  assert.equal(buildRelation(OTHER, B, { changedPaths }).relation, 'other-build');
  assert.equal(buildRelation('--output=x', B, { changedPaths: () => [] }).relation, 'other-build');
});

test('Entra writes follow the same rule: same-code counts, a code change is other-build', () => {
  const { C, recordsOnly, codeChange, changedPaths } = repoWithCommits();
  const captureLog = 'capture log';
  const files = { captureLog, record: { kind: ENTRA_LIVE_KIND, gate: ENTRA_LIVE_GATE, tenantRef: TEST_TENANT_REFS[0], build: C,
    synthetic: false, evidenceLevel: 'live-qualified', ok: true, outcome: 'succeeded', outcomeDetail: null, readBackVerified: true,
    observedAt: hoursAgo(1), captureSha256: createHash('sha256').update(captureLog).digest('hex') } };
  const at = (candidateBuild) => classifyEntraAtBuild(files, { candidateBuild, now: NOW, changedPaths });
  const same = at(recordsOnly);
  assert.equal(same.state, 'unverified');
  assert.deepEqual(same.sameCode, { range: `${C.slice(0, 10)}..${recordsOnly.slice(0, 10)}` });
  assert.equal(at(codeChange).state, 'other-build');
});

test('placeholders, fixture evidence and failed verification at the candidate', () => {
  const placeholder = signoff(fullDir((entry) => (entry.gate === 'drill-live-acceptance' ? { gate: entry.gate, status: 'pending' } : undefined)));
  assert.equal(placeholder.gates.find((gate) => gate.id === 'drill-live-acceptance').state, 'placeholder');
  assert.equal(placeholder.verdict, 'pending');

  const fixture = signoff(fullDir((entry, value) => (entry.gate === 'drill-live-acceptance' ? { ...value, synthetic: true, evidenceLevel: 'fixture-tested' } : undefined)));
  assert.equal(fixture.gates.find((gate) => gate.id === 'drill-live-acceptance').state, 'failed');
  assert.equal(fixture.verdict, 'blocked');

  const failing = signoff(fullDir(), { verify: (value, { gate }) => (gate === 'servicenow-live-acceptance' ? { ok: false, failures: ['bad signature'] } : { ok: true, failures: [] }) });
  assert.equal(failing.verdict, 'blocked');
  assert.deepEqual(failing.gates.find((gate) => gate.id === 'servicenow-live-acceptance').reasons, ['bad signature']);
});

test('the verifier is called at the candidate build with --require-live semantics and the gate\'s own age limit', () => {
  const calls = [];
  signoff(fullDir(), { verify: (value, options) => { calls.push(options); return { ok: true, failures: [] }; } });
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.build, B);
    assert.equal(call.requireLive, true);
    assert.equal(call.tenantRef, 'sha256:test');
  }
  assert.equal(calls.find((call) => call.gate === 'deployed-acceptance').maxAgeHours, 7 * 24);
  assert.equal(calls.find((call) => call.gate === 'storage-live-acceptance').maxAgeHours, 30 * 24);
});

test('an accepted gap never counts as qualified and still blocks when its record fails', () => {
  const ready = signoff(fullDir());
  const sentinel = ready.gates.find((gate) => gate.id === 'sentinel-live-acceptance');
  assert.equal(sentinel.state, 'placeholder');
  assert.equal(sentinel.holdsReadiness, false);
  assert.ok(!ready.shipped.includes('sentinel-live-acceptance'));
  assert.ok(buildRecapturePlan(ready).acceptedGaps.some((gap) => gap.id === 'sentinel-live-acceptance'));

  const broken = fullDir();
  writeFileSync(join(broken, 'sentinel-live-acceptance.json'), '{not json');
  assert.equal(signoff(broken).verdict, 'blocked');
});

test('Entra: a demoted write holds ready and is listed with why; a failed one blocks; a missing journey holds', () => {
  const demoted = signoff(fullDir(), { classifyEntra: () => ({ state: 'demoted', build: null, observedAt: hoursAgo(2), ageDays: 0, reasons: ['failed live on 2026-11-04: Graph 400'] }) });
  assert.equal(demoted.verdict, 'pending');
  assert.equal(demoted.entra.state, 'demoted');
  assert.deepEqual(buildRecapturePlan(demoted).entra.demoted.map((row) => row.operation), ['group.update']);

  const failed = signoff(fullDir(), { classifyEntra: () => ({ state: 'failed', build: B, observedAt: hoursAgo(2), ageDays: 0, reasons: ['capture log does not match'] }) });
  assert.equal(failed.verdict, 'blocked');

  const noJourney = signoff(fullDir(), { fixture: { ...passedJourneys, journeys: passedJourneys.journeys.slice(1) } });
  assert.equal(noJourney.verdict, 'pending');
  const failedJourney = signoff(fullDir(), { fixture: { ...passedJourneys, journeys: [{ journey: 'J1', outcome: 'failed' }, ...passedJourneys.journeys.slice(1)] } });
  assert.equal(failedJourney.verdict, 'blocked');
});

test('objective gaps hold ready unless the 2026-10-09 decision is applied, and stay listed as unsupported', () => {
  const held = signoff(fullDir(), { objectiveGapsAccepted: false });
  assert.equal(held.verdict, 'pending');
  const accepted = signoff(fullDir());
  for (const objective of accepted.objectives.filter((o) => o.gap)) {
    assert.equal(objective.liveQualified.status, 'no-live-gate');
    assert.ok(objective.manualOrUnsupported.some((m) => m.label === 'unsupported' && m.automated === false));
    assert.ok(!accepted.shipped.includes(objective.id), `${objective.id} is a gap, never shipped`);
  }
});

test('every objective reports implemented, live-qualified, manual or unsupported and deferred separately', () => {
  const report = signoff(fullDir());
  assert.deepEqual(report.objectives.map((o) => o.id), RELEASE_OBJECTIVES.map((o) => o.id));
  for (const objective of report.objectives) {
    assert.ok(['implemented', 'incomplete'].includes(objective.implemented.status));
    assert.ok(['live-qualified', 'not-live-qualified', 'no-live-gate'].includes(objective.liveQualified.status));
    assert.ok(Array.isArray(objective.manualOrUnsupported));
    assert.ok(Array.isArray(objective.deferred));
  }
});

test('manual routes are never automated', () => {
  const ledger = buildOperationLedger();
  const routes = recoveryRoutes({ ledger });
  const manualTypes = ledger.types.filter((type) => type.decision === 'manual').map((type) => type.resourceType);
  assert.ok(manualTypes.length > 0);
  const automated = new Set(routes.automated.map((route) => route.resourceType));
  for (const type of manualTypes) {
    assert.ok(!automated.has(type), `${type} is manual and must not be counted as automated`);
    const route = routes.manual.find((entry) => entry.route === type);
    assert.ok(route, `${type} is listed as a manual route`);
    assert.equal(route.recovery, 'manual');
    assert.equal(route.automated, false);
  }
  assert.equal(routes.automated.length, ledger.types.filter((type) => type.decision === 'automated').length);
  // A native route that is not credential-qualified is a manual handoff, and D2 shows it as manual.
  const fakeNative = { namedLocation: { route: 'deleted-named-locations', qualified: false, reason: 'not qualified' } };
  const withNative = recoveryRoutes({ ledger, nativeRoutes: fakeNative });
  assert.ok(withNative.manual.some((route) => route.route === 'deleted-named-locations' && route.automated === false));
  const report = signoff(fullDir(), { routes: withNative });
  const d2 = report.objectives.find((o) => o.id === 'D2');
  assert.ok(d2.manualOrUnsupported.some((m) => m.item === 'deleted-named-locations' && m.label === 'manual' && m.automated === false));
  assert.ok(d2.manualOrUnsupported.some((m) => m.item === 'conditional-access-enforcement' && m.label === 'manual'));
  assert.equal(report.recovery.automatedTypes, routes.automated.length);
  assert.ok(report.recovery.manual.every((route) => route.automated === false && route.recovery === 'manual'));
});

test('the deferred hybrid runtime never ships', () => {
  const deferred = deferredScope();
  const hybrid = deferred.find((item) => item.item === 'hybrid-agent-runtime');
  assert.equal(HYBRID_RUNTIME.status, 'deferred');
  assert.equal(hybrid.status, 'deferred');
  assert.equal(hybrid.shipped, false);
  assert.deepEqual(hybrid.problems, [], 'no hybrid runtime entrypoint exists in the tree');

  const ready = signoff(fullDir());
  assert.equal(ready.verdict, 'ready');
  assert.ok(!ready.shipped.includes('hybrid-agent-runtime'));
  assert.ok(ready.deferred.every((item) => item.shipped === false));
  const g5 = ready.objectives.find((o) => o.id === 'G5');
  assert.deepEqual(g5.deferred.map((d) => [d.item, d.shipped]), [['hybrid-agent-runtime', false]]);

  // Declaring the deferred runtime available (or finding it shipped) blocks sign-off.
  const declared = signoff(fullDir(), { deferred: deferredScope({ runtime: { ...HYBRID_RUNTIME, available: true } }) });
  assert.equal(declared.verdict, 'blocked');
  const marked = signoff(fullDir(), { deferred: deferred.map((item) => ({ ...item, shipped: true })) });
  assert.equal(marked.verdict, 'blocked');
});

test('write coverage counts only written-and-read-back live writes against the registered family', () => {
  const coverage = writeFamilyCoverage([{ subject: { writes: [
    { operationId: 'sharepoint-structure.site-script.add', ok: false, readBackVerified: false, synthetic: false, error: 'no actions' },
    { operationId: 'sharepoint-structure.hub-site.update', ok: true, readBackVerified: true, synthetic: false },
    { operationId: 'sharepoint-structure.hub-site.add', ok: true, readBackVerified: true, synthetic: false },
    { operationId: 'sharepoint-structure.site-template.update', ok: true, readBackVerified: true, synthetic: true },
  ] } }]);
  const structure = coverage.find((family) => family.family === 'sharepoint-structure');
  assert.equal(structure.registered, 7);
  assert.equal(structure.proven, 2);
  assert.equal(structure.missing.find((m) => m.operationId === 'sharepoint-structure.site-script.add').lastAttempt, 'no actions');
});

test('classifyRecordAtBuild states are in the declared order', () => {
  const entry = releaseGateInventory().find((row) => row.gate === 'deployed-acceptance');
  const at = (value, options = {}) => classifyRecordAtBuild(entry, value, { candidateBuild: B, hmacKey: 'k', tenantRef: 't', now: NOW, verify: okVerify, ...options }).state;
  assert.equal(at(null), 'missing');
  assert.equal(at({ unreadable: 'x' }), 'failed');
  assert.equal(at({ status: 'pending' }), 'placeholder');
  assert.equal(at(record('deployed-acceptance', { observedAt: 'nope' })), 'failed');
  assert.equal(at(record('deployed-acceptance', { observedAt: hoursAgo(9 * 24), build: OTHER })), 'stale');
  assert.equal(at(record('deployed-acceptance', { build: OTHER })), 'other-build');
  assert.equal(at(record('deployed-acceptance'), { hmacKey: null }), 'unverified');
  assert.equal(at(record('deployed-acceptance')), 'live-qualified');
  assert.ok(GATE_STATES.includes('live-qualified'));
});

// --- The checked-in records, as the operator sees them today (no key) -------

const exists = (path) => existsSync(join(REPO_ROOT, path));

test('checked-in records without the key: pending, never ready, every gate listed with state, build and age', () => {
  const report = buildReleaseSignoff({ candidateBuild: B, objectiveGapsAccepted: true });
  assert.equal(report.verdict, 'pending', report.reasons.join('\n'));
  assert.deepEqual(report.shipped, []);
  assert.deepEqual(report.gates.map((gate) => gate.id), releaseGateInventory().map((entry) => entry.id));
  for (const gate of report.gates) {
    assert.ok(GATE_STATES.includes(gate.state), `${gate.id}: ${gate.state}`);
    assert.notEqual(gate.state, 'live-qualified');
    assert.ok('build' in gate && 'ageDays' in gate);
  }
  const markdown = renderSignoffMarkdown(report);
  for (const gate of report.gates) assert.ok(markdown.includes(`\`${gate.id}\``), `${gate.id} is in the report`);
  assert.match(markdown, /Verdict: pending/);
});

test('checked-in records: the recapture plan names every gate and Entra write that needs a capture, demotions first', () => {
  const report = buildReleaseSignoff({ candidateBuild: B, objectiveGapsAccepted: true });
  const plan = buildRecapturePlan(report);
  const planned = new Set(plan.gates.map((gate) => gate.id));
  for (const gate of report.gates.filter((row) => row.holdsReadiness && row.state !== 'live-qualified')) {
    assert.ok(planned.has(gate.id), `${gate.id} (${gate.state}) is in the recapture plan`);
  }
  for (const gate of plan.gates) {
    assert.ok(gate.capture && gate.verify, `${gate.id} has capture and verify commands`);
    assert.ok(exists(gate.doc), `${gate.id}: ${gate.doc} exists`);
  }
  const demotions = readdirSync(join(REPO_ROOT, 'docs/release/qualifications/entra-live'))
    .filter((name) => name.endsWith('.demotion.json')).map((name) => name.replace(/\.demotion\.json$/, ''));
  const plannedDemotions = plan.entra.demoted.map((row) => row.operation);
  for (const stem of demotions) {
    const row = report.entra.operations.find((op) => op.stem === stem);
    if (row?.state === 'demoted') assert.ok(plannedDemotions.includes(stem), `${stem} demotion is in the plan`);
  }
  const entraPlanned = new Set([...plannedDemotions, ...plan.entra.recapture.map((row) => row.operation)]);
  for (const row of report.entra.operations.filter((op) => op.state !== 'live-qualified' && op.state !== 'unverified')) {
    assert.ok(entraPlanned.has(row.stem), `${row.stem} (${row.state}) is in the plan`);
  }
  // Writer families with registered writes the records do not prove are listed.
  for (const family of report.writeCoverage.filter((entry) => entry.proven < entry.registered)) {
    assert.ok(plan.partialWrites.some((entry) => entry.family === family.family));
  }
});

test('evidence links in the report resolve to files that exist', () => {
  const report = buildReleaseSignoff({ candidateBuild: B, objectiveGapsAccepted: true });
  const links = [
    ...report.gates.flatMap((gate) => [gate.record, gate.doc]),
    report.entra.doc,
    ...report.entra.operations.flatMap((row) => [row.record, row.demotion]),
    ...report.objectives.flatMap((o) => o.implemented.tests.map((t) => t.path)),
    ...report.deferred.map((item) => item.source),
  ].filter(Boolean);
  assert.ok(links.length > 50);
  for (const link of links) assert.ok(exists(link), `${link} exists`);
  assert.ok(report.objectives.every((o) => o.implemented.status === 'implemented'));
});

test('the checked-in final-acceptance.json is a generated sign-off that does not claim ready', () => {
  const path = join(REPO_ROOT, 'docs/release/final-acceptance.json');
  const final = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(final.contractVersion, 1);
  assert.notEqual(final.verdict, 'ready');
  assert.deepEqual(final.shipped, []);
  assert.deepEqual(final.gates.map((gate) => gate.id), releaseGateInventory().map((entry) => entry.id));
  assert.ok(final.deferred.every((item) => item.shipped === false));
  for (const gate of final.gates) if (gate.record) assert.ok(exists(gate.record), gate.record);
  assert.ok(final.recapturePlan && Array.isArray(final.recapturePlan.gates));
});
