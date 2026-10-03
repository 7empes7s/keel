import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateLicense } from '../../tools/qualification/benchmarkLicense.mjs';
import { importPack, evaluatePack, packCacheMatches } from '../benchmarks/packs.mjs';
import { importSecureScore, presentSecureScore } from '../benchmarks/secureScore.mjs';
import { registerControl, registerPredicate } from '../benchmarks/registry.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const tenantId = 'synthetic-tenant';
const tenantRef = tenantRefFor(tenantId);
const now = new Date('2026-09-25T12:00:00Z');
let invocations = 0;
registerPredicate('task86.synthetic', () => { invocations++; return 'pass'; });
registerControl({ controlId: 'task86.synthetic', title: 'Synthetic original check',
  description: 'Original test-only predicate, no licensed content.', framework: 'keel-custom',
  edition: '1', profile: 'default', evaluatorVersion: 1,
  requiredObservations: [{ resourceType: 'group', maxAgeMs: 60000 }],
  predicate: { name: 'task86.synthetic' } });
const refs = [{ framework: 'ISO', edition: 'synthetic', ref: 'example-only' },
  { framework: 'NIS2', edition: 'synthetic', ref: 'example-only' }];
function fixture(changes = {}) {
  const document = { packId: 'synthetic-pack', version: '1', edition: 'synthetic', profile: 'test',
    controls: [{ controlId: 'task86.synthetic', evaluatorVersion: 1, frameworkRefs: refs }], ...changes };
  const source = JSON.stringify(document);
  const rights = { edition: document.edition, profile: document.profile,
    sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    redistributionScope: 'tenant-only', rightsEvidence: 'synthetic-grant', tenantRef };
  const grants = [{ ...rights }];
  return { source, rights, grants };
}
// Exercise the real can()/role-grant seam through a fake DB; grants can be revoked mid-request.
function context() {
  const state = { roles: ['admin', 'viewer', 'operator'] };
  return { state, tenantRef, principal: { id: 'test-principal' },
    client: { async query(sql) { assert.match(sql, /JOIN principal/); return { rows: state.roles.map(role => ({ role, scope: '*' })) }; } } };
}

test('licensed imports reject missing, forged, insufficient and mismatched rights before evaluation', async () => {
  const f = fixture();
  for (const patch of [{ rights: undefined }, { grants: [] },
    { rights: { ...f.rights, edition: 'other' } },
    { rights: { ...f.rights, sourceDigest: 'sha256:bad' } },
    { rights: { ...f.rights, redistributionScope: 'embedded' } },
    { rights: { ...f.rights, tenantRef: 'sha256:other' } }]) {
    await assert.rejects(importPack({ ...context(), ...f, ...patch }), /rights|license|digest|scope/i);
  }
  assert.throws(() => validateLicense({ ...f, tenantRef, use: 'embedded' }), /scope/i);
  const embedded = { ...f.rights, redistributionScope: 'embedded' };
  assert.equal(validateLicense({ ...f, rights: embedded, grants: [embedded], tenantRef, use: 'embedded' }).sourceDigest, f.rights.sourceDigest);
});

test('reviewed grants pin exact source content even when every other rights field matches', async () => {
  const original = fixture();
  const changed = fixture({ version: '2' });
  assert.notEqual(changed.rights.sourceDigest, original.rights.sourceDigest);
  assert.deepEqual({ ...changed.rights, sourceDigest: original.rights.sourceDigest }, original.rights);
  assert.equal(validateLicense({ ...changed, tenantRef }).sourceDigest, changed.rights.sourceDigest);
  assert.throws(() => validateLicense({ ...changed, grants: original.grants, tenantRef }), /no matching reviewed grant/);
  await assert.rejects(importPack({ ...context(), ...changed, grants: original.grants }), /no matching reviewed grant/);
});

test('reviewed grants cannot be reused across tenants for identical source content', async () => {
  const f = fixture();
  const otherTenantRef = tenantRefFor('synthetic-other-tenant');
  const foreignGrant = { ...f.rights, tenantRef: otherTenantRef };
  assert.deepEqual({ ...foreignGrant, tenantRef }, f.rights);
  assert.equal(validateLicense({ ...f, tenantRef }).tenantRef, tenantRef);
  const pack = await importPack({ ...context(), ...f });
  assert.equal(pack.rights.tenantRef, tenantRef);
  assert.throws(() => validateLicense({ ...f, grants: [foreignGrant], tenantRef }), /no matching reviewed grant/);
  await assert.rejects(importPack({ ...context(), ...f, grants: [foreignGrant] }), /no matching reviewed grant/);
});

test('pack-supplied certification relationships remain evidence links at import and evaluation', async () => {
  const ctx = context();
  const pack = await importPack({ ...ctx, ...fixture({ controls: [{
    controlId: 'task86.synthetic', evaluatorVersion: 1,
    frameworkRefs: refs.map(ref => ({ ...ref, relationship: 'certified' })),
  }] }) });
  const expected = refs.map(ref => ({ ...ref, profile: null, relationship: 'evidence-link' }));
  assert.deepEqual(pack.controls[0].frameworkRefs, expected);
  const result = await evaluatePack({ ...ctx, pack, now });
  assert.deepEqual(result.evidenceLinks, expected.map(ref => ({ controlId: 'task86.synthetic', ...ref })));
});

test('multi-framework evidence links evaluate one authored control exactly once without external points', async () => {
  const ctx = context();
  const pack = await importPack({ ...ctx, ...fixture() });
  const before = invocations;
  const result = await evaluatePack({ ...ctx, pack, now, observations: { group: {
    observation: { tenantRef, resourceType: 'group', completeness: 'complete',
      window: { startedAt: now.toISOString(), endedAt: now.toISOString() } }, resources: [] } } });
  assert.equal(invocations - before, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].verdict, 'pass');
  assert.equal(result.qualification, 'fixture-tested');
  assert.equal(result.evidenceLinks.length, 2);
  assert.equal(result.externalPoints, undefined);
  assert.equal(result.certified, undefined);
  assert.equal(packCacheMatches(pack, result), true);
  for (const patch of [{ version: '2' }, { edition: 'new' }, { profile: 'new' }]) {
    const updated = await importPack({ ...ctx, ...fixture(patch) });
    assert.equal(packCacheMatches(updated, result), false);
  }
  const remapped = await importPack({ ...ctx, ...fixture({ controls: [{ controlId: 'task86.synthetic',
    evaluatorVersion: 1, frameworkRefs: refs.slice(0, 1) }] }) });
  assert.equal(packCacheMatches(remapped, result), false);
  assert.equal(packCacheMatches(pack, { results: result.results }), false); // legacy cache
  await assert.rejects(evaluatePack({ ...ctx, tenantRef: 'sha256:other', pack }), /tenant/i);
  await assert.rejects(evaluatePack({ ...ctx, pack: { ...pack } }), /rights-validated/i);
  const missing = await evaluatePack({ ...ctx, pack, now });
  assert.equal(missing.results[0].verdict, 'unknown');
  assert.equal(missing.qualification, 'fixture-tested');
  assert.equal(packCacheMatches(pack, { ...result, tenantRef: 'sha256:other' }), false);
  assert.throws(() => { pack.controls[0].evaluatorVersion = 9; }, TypeError);
  await assert.rejects(importPack({ ...ctx, ...fixture({ controls: [
    { controlId: 'task86.synthetic', evaluatorVersion: 2, frameworkRefs: refs }] }) }), /version/i);
  await assert.rejects(importPack({ ...ctx, ...fixture({ controls: [
    ...JSON.parse(fixture().source).controls, ...JSON.parse(fixture().source).controls] }) }), /duplicate/i);
  ctx.state.roles = [];
  await assert.rejects(evaluatePack({ ...ctx, pack }), /forbidden/i);
  await assert.rejects(importPack({ ...ctx, ...fixture() }), /forbidden/i);
});

test('pack import rejects licensed-provenance controls even with matching reviewed pack rights', async () => {
  registerControl({ controlId: 'task86.synthetic-licensed', title: 'Synthetic provenance fixture',
    description: 'Test-only original wording; contains no licensed benchmark content.',
    framework: 'synthetic', edition: '1', profile: 'test', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: 60000 }],
    predicate: { name: 'task86.synthetic' },
    provenance: { source: 'licensed', rightsEvidence: 'synthetic-control-grant' } });
  const f = fixture({ controls: [{ controlId: 'task86.synthetic-licensed', evaluatorVersion: 1 }] });
  assert.equal(validateLicense({ ...f, tenantRef }).sourceDigest, f.rights.sourceDigest);
  const before = invocations;
  await assert.rejects(importPack({ ...context(), ...f }), /pack must reference a registered authored control/);
  assert.equal(invocations, before);
});

function scoreReader(value, overrides = {}) {
  return { tenantRef, credentialMode: 'collector', credentialRef: 'collector-test',
    async get(path) { assert.equal(path, '/v1.0/security/secureScores?$top=1'); return { value }; }, ...overrides };
}
const score = { id: 'synthetic-score', azureTenantId: tenantId,
  createdDateTime: now.toISOString(), currentScore: 17, maxScore: 80 };
test('Secure Score read adapter preserves external numerator, denominator, timestamp and provenance', async () => {
  const result = await importSecureScore({ ...context(), reader: scoreReader([score]), now });
  assert.equal(result.status, 'available');
  assert.equal(result.currentScore, 17);
  assert.equal(result.maxScore, 80);
  assert.equal(result.scoredAt, score.createdDateTime);
  assert.equal(result.provenance.credentialMode, 'collector');
  assert.equal(result.provenance.source, 'microsoft-graph');
  assert.equal(result.verdict, undefined);
  assert.match(presentSecureScore(result), /17 \/ 80/);
});

test('Secure Score presentation refuses otherwise-valid results with spoofed or missing provenance', async () => {
  const result = await importSecureScore({ ...context(), reader: scoreReader([score]), now });
  assert.equal(presentSecureScore(result), `Microsoft Secure Score: 17 / 80 (external; ${score.createdDateTime})`);
  for (const provenance of [undefined, { ...result.provenance, source: undefined },
    { ...result.provenance, source: 'spoofed-provider' }]) {
    assert.equal(presentSecureScore({ ...result, provenance }), 'Microsoft Secure Score: unknown');
  }
});

test('Secure Score presentation refuses otherwise-valid results with invalid or missing scoredAt', async () => {
  const result = await importSecureScore({ ...context(), reader: scoreReader([score]), now });
  assert.equal(presentSecureScore(result), `Microsoft Secure Score: 17 / 80 (external; ${score.createdDateTime})`);
  for (const scoredAt of ['garbage-timestamp', '', undefined, null]) {
    assert.equal(presentSecureScore({ ...result, scoredAt }), 'Microsoft Secure Score: unknown');
  }
});

test('missing, stale, partial, malformed and failed Score reads remain unknown, never zero-risk pass', async () => {
  for (const value of [[], [null], [{ ...score, currentScore: null }], [{ ...score, maxScore: 0 }],
    [{ ...score, maxScore: undefined }], [{ ...score, currentScore: '17' }],
    [{ ...score, currentScore: -1 }], [{ ...score, currentScore: 81 }], [{ ...score, createdDateTime: 'bad' }],
    [{ ...score, createdDateTime: '2020-01-01T00:00:00Z' }],
    [{ ...score, createdDateTime: '2030-01-01T00:00:00Z' }]]) {
    const result = await importSecureScore({ ...context(), reader: scoreReader(value), now });
    assert.equal(result.status, 'unknown');
    assert.equal(result.currentScore, null);
    assert.equal(result.maxScore, null);
    assert.equal(result.scoredAt, null);
    assert.equal(presentSecureScore(result), 'Microsoft Secure Score: unknown');
  }
  const failed = await importSecureScore({ ...context(), now,
    reader: scoreReader([], { get() { throw new Error('secret token'); } }) });
  assert.equal(failed.reason, 'read-failed');
  const empty = await importSecureScore({ ...context(), reader: scoreReader([]), now });
  assert.equal(empty.reason, 'empty-read');
  for (const response of [{}, { value: null }, { value: [score, score] }]) {
    const result = await importSecureScore({ ...context(), now,
      reader: scoreReader([], { async get() { return response; } }) });
    assert.equal(result.status, 'unknown');
  }
  assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.equal(presentSecureScore({ currentScore: 0 }), 'Microsoft Secure Score: unknown');
  const zero = await importSecureScore({ ...context(), reader: scoreReader([{ ...score, currentScore: 0 }]), now });
  assert.equal(zero.status, 'available');
  assert.equal(zero.currentScore, 0);
});

test('Secure Score malformed tenant IDs remain unknown without coercion or invented scores', async () => {
  for (const azureTenantId of [undefined, null, '', '   ', 0, 42, false, true, {}, [], [tenantId]]) {
    const result = await importSecureScore({ ...context(), now,
      reader: scoreReader([{ ...score, azureTenantId }]) });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'missing-invalid-or-stale-data');
    assert.equal(result.currentScore, null);
    assert.equal(result.maxScore, null);
    assert.equal(result.scoredAt, null);
    assert.equal(presentSecureScore(result), 'Microsoft Secure Score: unknown');
  }
});

test('Score refuses restorer credentials, cross-tenant input and revoked authorization', async () => {
  let reads = 0;
  const reader = scoreReader([score], { credentialMode: 'restorer', get() { reads++; } });
  await assert.rejects(importSecureScore({ ...context(), reader, now }), /collector/i);
  assert.equal(reads, 0);
  await assert.rejects(importSecureScore({ ...context(), reader: scoreReader([score], { tenantRef: 'sha256:other' }), now }), /tenant/i);
  await assert.rejects(importSecureScore({ ...context(), reader: scoreReader([{ ...score, azureTenantId: 'other' }]), now }), /tenant/i);
  const ctx = context();
  ctx.state.roles = [];
  await assert.rejects(importSecureScore({ ...ctx, reader: scoreReader([score]), now }), /forbidden/i);
  const revoked = context();
  await assert.rejects(importSecureScore({ ...revoked, now, reader: scoreReader([], {
    async get() { revoked.state.roles = []; return { value: [score] }; },
  }) }), /forbidden/i);
});

test('qualification CLI validates synthetic license and rejects unlicensed input without exposing source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keel-license-'));
  try {
    const f = fixture();
    const file = join(dir, 'fixture.json');
    await writeFile(file, JSON.stringify({ ...f, tenantRef }));
    const run = () => spawnSync(process.execPath, ['tools/qualification/benchmarkLicense.mjs', file], { encoding: 'utf8' });
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).status, 'fixture-tested');
    assert.equal(JSON.parse(accepted.stdout).liveQualified, false);
    await writeFile(file, JSON.stringify({ ...f, rights: undefined, tenantRef }));
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /license validation failed/);
    assert.ok(!refused.stderr.includes('Synthetic original'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
