/**
 * Roadmap task-47 boundary tests: structured per-type collection outcomes.
 * Exercises the production Graph reader, entra adapter, snapshot persistence
 * and coverage report against adversarial fixtures and the isolated test
 * database — including the three required mutation checks:
 *
 * - Discard structured Graph error code.
 * - Mark second-page failure complete.
 * - Rewrite unavailable outcome to complete-empty.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { GraphReader, redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { collectWithOutcomes } from '../collect/entraAdapter.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { readCoverageOutcome, readOutcome, readOutcomeDetail } from '../coverage/snapshots.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { isEligibleBaselineSource } from '../govern/baseline.mjs';
import { main as collectMain, runCollect } from '../../cli/keel-collect.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// The well-known jwt.io example token: structurally a JWT, not a credential.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';

test('redactSecrets strips bearer and token-shaped values, keeps prose and codes', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets('Access denied'), 'Access denied');
  assert.equal(redactSecrets('code Error_AccessDenied stays'), 'code Error_AccessDenied stays');
  const redacted = redactSecrets(`Authorization: Bearer ${JWT} was rejected`);
  assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT header segment removed');
  assert.ok(!redacted.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'), 'JWT signature removed');
  assert.ok(redacted.includes('[redacted]'));
  assert.ok(redacted.includes('was rejected'), 'surrounding prose survives');
  // A long token-shaped run without the Bearer prefix is also stripped.
  assert.ok(!redactSecrets(`token ${'a'.repeat(64)} end`).includes('a'.repeat(64)));
});

test('GraphReader: a second-page failure keeps page-one items, code and status, redacted message', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (requested.length === 1) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          value: [{ id: 'g1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups?$skiptoken=page2',
        }),
      };
    }
    return {
      ok: false, status: 500, statusText: 'Internal Server Error', headers: { get: () => null },
      json: async () => ({ error: { code: 'Error_InternalServer', message: `backend failed; echoed Authorization: Bearer ${JWT}` } }),
    };
  };
  const reader = new GraphReader(async () => 'fixture-token');
  const result = await reader.collect('v1.0', '/groups');

  assert.equal(requested.length, 2, 'the walk attempted page two');
  // Mutation pin (2): the first page is partial evidence, never a completion.
  assert.deepEqual(result.items, [{ id: 'g1' }], 'first-page items survive the second-page failure');
  assert.equal(result.pages, 1);
  // The walk broke on an error while a nextLink was still pending: the real
  // reader reports `capped: true` alongside `error`, so downstream outcome
  // handling must always see both fields together on a second-page failure.
  assert.equal(result.capped, true, 'an errored mid-walk stop is also capped');
  // Mutation pin (1): the structured Graph code survives the read path.
  assert.equal(result.error.code, 'Error_InternalServer');
  assert.equal(result.error.status, 500);
  assert.ok(!result.error.error.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'bearer token never leaves the reader');
  assert.match(result.error.error, /backend failed/);

  // A fully successful empty walk reads as zero items with all pages done.
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({ value: [] }),
  });
  const empty = await reader.collect('v1.0', '/groups');
  assert.deepEqual({ items: empty.items, pages: empty.pages, capped: empty.capped, error: empty.error }, {
    items: [], pages: 1, capped: false, error: null,
  });
});

test('adapter digest: complete, complete-empty, partial and failed stay distinct with evidence', async () => {
  const reader = {
    async collect(version, path) {
      if (path.startsWith('/users?')) return { items: [{ id: 'u1' }], pages: 1, status: 200, error: null };
      if (path.startsWith('/groups?')) return { items: [{ id: 'g1' }, { id: 'g2' }], pages: 1, error: { status: 500, code: 'Error_InternalServer', error: `denied on page 2; echoed Authorization: Bearer ${JWT}` } };
      if (path === '/roleManagement/directory/roleAssignments') return { items: [], pages: 0, error: { status: 403, code: 'Error_AccessDenied', error: 'denied' } };
      if (path === '/roleManagement/directory/roleEligibilitySchedules') throw new Error('connection reset');
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { collected, coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });

  // Mutation pin (3): an unavailable read can never be rewritten to
  // complete-empty — the failed outcome, code and unknown cardinality hold.
  const denied = coverageDigest.roleAssignment;
  assert.equal(denied.outcome, 'failed');
  assert.notEqual(denied.outcome, 'complete-empty');
  assert.equal(denied.itemCount, null, 'unknown cardinality is never an invented zero');
  assert.equal(denied.graphCode, 'Error_AccessDenied');
  assert.equal(denied.httpStatus, 403);

  // A transport failure that throws before any page is likewise failed with
  // unknown cardinality — never rewritten to complete-empty.
  const transport = coverageDigest.roleEligibilitySchedule;
  assert.equal(transport.outcome, 'failed');
  assert.notEqual(transport.outcome, 'complete-empty');
  assert.equal(transport.itemCount, null);
  assert.match(transport.error, /connection reset/);

  // Mutation pin (2): the second-page failure is partial — first-page count
  // preserved, completeness failed, payload never collected as complete.
  const group = coverageDigest.group;
  assert.equal(group.outcome, 'partial');
  assert.notEqual(group.outcome, 'complete');
  assert.equal(group.itemCount, 2, 'first-page partial count is preserved');
  assert.equal(group.graphCode, 'Error_InternalServer');
  assert.equal(group.pagesCompleted, 1);
  assert.equal(collected.some(([type]) => type === 'group'), false);
  // Write-path redaction: the adapter redacts before the digest entry exists,
  // so the stored digest and CLI table output can never carry a token; the
  // report-read boundary is defense in depth, not the only barrier.
  assert.match(group.error, /denied on page 2/, 'prose survives redaction');
  assert.ok(!group.error.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'adapter digest stores no JWT segment');
  assert.ok(!group.error.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'), 'adapter digest stores no token signature');

  // Empty success is complete-empty: a strict coverage success.
  const empty = coverageDigest.namedLocation;
  assert.equal(empty.outcome, 'complete-empty');
  assert.equal(empty.itemCount, 0);
  assert.equal(readCoverageOutcome(empty).covered, true, 'empty success stays a strict coverage success');
  assert.equal(readCoverageOutcome(empty).itemCount, 0, 'a complete-empty entry reads as covered with itemCount 0');
  assert.equal(readCoverageOutcome(group).covered, false, 'partial fails completeness');
  assert.equal(readCoverageOutcome(group).itemCount, 2, 'partial count survives the outcome read');
  assert.equal(readCoverageOutcome(denied).covered, false);
  // A versioned (observation contract v1) entry follows the same rule: a
  // recorded complete-empty is covered with a real zero count.
  assert.deepEqual(
    readCoverageOutcome({ contractVersion: 1, outcome: 'complete-empty', itemCount: 0 }),
    { covered: true, itemCount: 0 },
    'a versioned complete-empty entry reads as covered with itemCount 0',
  );

  // Structured evidence is present where observed, null where not.
  assert.equal(coverageDigest.user.apiVersion, 'v1.0');
  assert.ok(coverageDigest.user.endpoint.startsWith('/users'));
  assert.ok(!Number.isNaN(Date.parse(group.startedAt)) && !Number.isNaN(Date.parse(group.completedAt)));
});

test('adapter digest: an errored and capped walk keeps the Graph evidence (branch order)', async () => {
  // The real GraphReader.collect() returns exactly this shape on a second-page
  // failure: the walk broke on an error while a nextLink was still pending, so
  // `capped` is true alongside `error` and `status` is the last *successful*
  // page's status. The error branch must win — a capped-first check would
  // silently discard the Graph code, HTTP status and message from the outcome.
  const reader = {
    async collect(version, path) {
      if (path.startsWith('/groups?')) {
        return {
          items: [{ id: 'g1' }], pages: 1, status: 200, capped: true,
          error: { status: 500, code: 'Error_InternalServer', error: 'backend failed on page 2' },
        };
      }
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { collected, coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  const group = coverageDigest.group;
  assert.equal(group.outcome, 'partial');
  assert.equal(group.itemCount, 1, 'first-page partial count is preserved');
  assert.equal(group.graphCode, 'Error_InternalServer', 'the Graph code survives a capped-and-errored walk');
  assert.equal(group.httpStatus, 500, 'the failing page status wins over the last successful page status');
  assert.match(group.error, /backend failed on page 2/);
  assert.equal(collected.some(([type]) => type === 'group'), false, 'the partial payload is never collected as complete');
});

test('adapter digest: a thrown exception carrying a token is redacted before the digest entry exists', async () => {
  // The transport/auth failure path throws out of collectRaw before any
  // structured error exists; the catch branch is the only barrier between that
  // exception and the persisted digest, so it redacts exactly like the
  // structured-error path.
  const reader = {
    async collect(version, path) {
      if (path === '/organization') return { items: [{ id: 'fixture-tenant' }], pages: 1, status: 200, error: null };
      if (path.startsWith('/groups?')) throw new Error(`transport failed; sent Authorization: Bearer ${JWT}`);
      if (path.startsWith('/users?')) throw `non-error rejection carrying Bearer ${JWT}`;
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { collected, coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });

  for (const type of ['group', 'user']) {
    const entry = coverageDigest[type];
    assert.equal(entry.outcome, 'failed');
    assert.equal(entry.itemCount, null, 'a thrown read has unknown cardinality');
    assert.ok(!entry.error.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), `${type}: JWT header segment never reaches the digest`);
    assert.ok(!entry.error.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'), `${type}: token signature never reaches the digest`);
  }
  assert.match(coverageDigest.group.error, /transport failed/, 'prose survives redaction');
  assert.match(coverageDigest.user.error, /non-error rejection/, 'a non-Error throw keeps its message text');
  assert.equal(collected.some(([type]) => type === 'group' || type === 'user'), false);
});

test('baseline eligibility: complete-empty qualifies as a strict success, partial and failed never do', () => {
  const tenantRef = 'sha256:baseline-eligibility';
  const digestWith = (outcomeFor) => Object.fromEntries(
    DESCRIPTORS.map(({ type }) => [type, { outcome: outcomeFor(type), itemCount: 0 }]),
  );
  const snapshot = (digest, overrides = {}) => ({
    tenant_ref: tenantRef, status: 'complete', completed_at: '2026-09-18T10:05:00Z',
    coverage_digest: digest, ...overrides,
  });

  assert.equal(isEligibleBaselineSource(snapshot(digestWith(() => 'complete')), { tenantRef }), true);
  // Mutation pin: an eligibility check requiring 'complete' only would wrongly
  // exclude a whole-estate read whose types are all complete-empty.
  assert.equal(isEligibleBaselineSource(snapshot(digestWith(() => 'complete-empty')), { tenantRef }), true,
    'a completed empty read is eligible, exactly like complete');
  assert.equal(isEligibleBaselineSource(snapshot(digestWith((type) => (type === 'group' ? 'partial' : 'complete'))), { tenantRef }), false,
    'a partial type never qualifies a whole-estate baseline source');
  assert.equal(isEligibleBaselineSource(snapshot(digestWith((type) => (type === 'group' ? 'failed' : 'complete'))), { tenantRef }), false);
  assert.equal(isEligibleBaselineSource(snapshot(digestWith((type) => (type === 'group' ? 'not-requested' : 'complete'))), { tenantRef }), false,
    'a tier-filtered snapshot is not a whole-estate source');
  const missing = digestWith(() => 'complete');
  delete missing[DESCRIPTORS[0].type];
  assert.equal(isEligibleBaselineSource(snapshot(missing), { tenantRef }), false, 'an unrecorded type never qualifies');
  assert.equal(isEligibleBaselineSource(snapshot(digestWith(() => 'complete'), { tenant_ref: 'sha256:other' }), { tenantRef }), false);
  assert.equal(isEligibleBaselineSource(snapshot(digestWith(() => 'complete'), { status: 'running' }), { tenantRef }), false);
  assert.equal(isEligibleBaselineSource(snapshot(digestWith(() => 'complete'), { completed_at: null }), { tenantRef }), false);
});

test('keel-collect exit code: partial and failed outcomes fail the run, empty success does not', async () => {
  const noopLogger = { log() {}, error() {} };
  const run = async (coverageDigest) => {
    let ended = false;
    const { exitCode } = await runCollect({
      config: { tenantId: 'fixture-tenant' },
      dbUrl: 'postgres://fixture',
      dependencies: {
        connect: async () => ({ end: async () => { ended = true; } }),
        getToken: async () => ({ accessToken: 'fixture-token' }),
        GraphReader: class {},
        collectSnapshot: async () => ({ snapshotId: 'fixture-snapshot', coverageDigest }),
      },
      logger: noopLogger,
    });
    assert.equal(ended, true, 'the client closes on every outcome');
    return exitCode;
  };

  // Mutation pin: dropping 'partial' from the exit-code check would let a
  // second-page failure exit 0.
  assert.equal(await run({ group: { outcome: 'partial', itemCount: 2 } }), 1, 'a partial read exits nonzero');
  assert.equal(await run({ group: { outcome: 'failed', itemCount: null } }), 1, 'a failed read exits nonzero');
  assert.equal(await run({ group: { outcome: 'complete', itemCount: 3 } }), 0);
  assert.equal(await run({ group: { outcome: 'complete-empty', itemCount: 0 } }), 0, 'an empty success keeps a zero exit');
  assert.equal(await run({ group: { outcome: 'not-requested', itemCount: null } }), 0, 'an excluded tier is not a failure');

  // main() threads argv/readFile through to the same decision.
  const exitCode = await collectMain({
    argv: ['node', 'keel-collect.mjs', '--config', '/fixtures/tenant.json', '--db-url', 'postgres://fixture'],
    readFile: () => JSON.stringify({ tenantId: 'fixture-tenant' }),
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      getToken: async () => ({ accessToken: 'fixture-token' }),
      GraphReader: class {},
      collectSnapshot: async () => ({ snapshotId: 'fixture-snapshot', coverageDigest: { group: { outcome: 'partial', itemCount: 1 } } }),
    },
    logger: noopLogger,
  });
  assert.equal(exitCode, 1, 'main returns the failing exit code to runCli');

  await assert.rejects(
    () => collectMain({ argv: ['node', 'keel-collect.mjs', '--tier', 'tier9'], readFile: () => '{}', logger: noopLogger }),
    /--tier must be tier1, tier2, or tier3/,
  );
});

test('readObservation normalizes structured entries without inventing evidence', () => {
  const ctx = { tenantRef: 'sha256:t', observationId: 'snap:group', resourceType: 'group' };
  const structured = readObservation({
    outcome: 'partial', itemCount: 2, error: 'denied on page 2', httpStatus: 500, graphCode: 'Error_InternalServer',
    endpoint: '/groups', apiVersion: 'v1.0',
    startedAt: '2026-09-17T08:00:00Z', completedAt: '2026-09-17T08:01:00Z', pagesCompleted: 1,
  }, { ...ctx, snapshotWindow: { startedAt: '2026-09-17T07:00:00Z', endedAt: '2026-09-17T07:05:00Z' } });
  assert.equal(structured.completeness, 'partial');
  assert.deepEqual(structured.window, {
    startedAt: '2026-09-17T08:00:00.000Z', endedAt: '2026-09-17T08:01:00.000Z',
  }, 'a structured entry keeps its own observation window');
  assert.equal(structured.evidenceLevel, 'unknown', 'a digest row never promotes itself');

  assert.equal(readObservation({ outcome: 'complete-empty', itemCount: 0 }, ctx).completeness, 'complete');
  assert.equal(readObservation({ outcome: 'not-requested', itemCount: null }, ctx).completeness, 'unknown',
    'not-requested is the absence of an observation, never a claim');
  // Legacy message-only entries keep the snapshot window and their meaning.
  const legacy = readObservation({ outcome: 'failed', itemCount: null, error: 'denied' },
    { ...ctx, snapshotWindow: { startedAt: '2026-09-17T07:00:00Z', endedAt: '2026-09-17T07:05:00Z' } });
  assert.equal(legacy.completeness, 'failed');
  assert.deepEqual(legacy.window, { startedAt: '2026-09-17T07:00:00.000Z', endedAt: '2026-09-17T07:05:00.000Z' });

  // readOutcome/readOutcomeDetail: vocabulary and evidence, nothing invented.
  assert.equal(readOutcome({ outcome: 'complete-empty', itemCount: 0 }), 'complete-empty');
  assert.equal(readOutcome(5), null, 'a bare legacy count carries no outcome vocabulary');
  assert.equal(readOutcomeDetail(5), null, 'a bare legacy count has no detail to invent');
  const detail = readOutcomeDetail({ outcome: 'failed', itemCount: null, error: `denied; Bearer ${JWT}` });
  assert.equal(detail.httpStatus, null, 'unevidenced fields stay null');
  assert.ok(!detail.message.includes('eyJ'), 'old message-only digests are redacted at the read boundary too');
  assert.equal(readOutcomeDetail({ outcome: 'not-requested', itemCount: null }), null,
    'not-requested carries no observation evidence');
});

// ------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

test('structured outcomes persist, report and never shadow older evidence', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:outcomes-test';
  const reader = {
    async collect(version, path) {
      if (path === '/organization') return { items: [{ id: 'fixture-tenant', displayName: 'Fixture' }], pages: 1, status: 200, error: null };
      if (path.startsWith('/users?')) return { items: [{ id: 'u1', userPrincipalName: 'user@example.test' }], pages: 1, status: 200, error: null };
      if (path.startsWith('/groups?')) return { items: [{ id: 'g1' }, { id: 'g2' }], pages: 1, error: { status: 500, code: 'Error_InternalServer', error: `denied on page 2; Authorization: Bearer ${JWT}` } };
      if (path === '/roleManagement/directory/roleAssignments') return { items: [], pages: 0, error: { status: 403, code: 'Error_AccessDenied', error: 'denied' } };
      if (path === '/roleManagement/directory/roleEligibilitySchedules') throw new Error('connection reset');
      return { items: [], pages: 1, status: 200, error: null };
    },
  };

  // An older full run observed users and groups successfully (legacy shape).
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z', 'complete', $2)`,
    [tenantRef, JSON.stringify({
      user: { outcome: 'complete', itemCount: 7 },
      group: { outcome: 'complete', itemCount: 9 },
    })],
  );

  // A newer tier1 run: group fails on page two, roleAssignment on page one,
  // tier2/tier3 types are not requested at all.
  const { snapshotId, coverageDigest } = await collectSnapshot(client, {
    reader, tenantRef, tenantId: 'fixture-tenant', tier: 'tier1',
  });
  assert.equal(coverageDigest.group.outcome, 'partial');
  assert.equal(coverageDigest.user.outcome, 'not-requested', 'tier-excluded types are explicit, not silent');

  // The structured entries survive storage exactly.
  const { rows } = await client.query('SELECT coverage_digest FROM snapshot WHERE id = $1', [snapshotId]);
  const stored = rows[0].coverage_digest;
  assert.equal(stored.group.outcome, 'partial');
  assert.equal(stored.group.itemCount, 2, 'first-page partial count survives storage');
  assert.equal(stored.group.graphCode, 'Error_InternalServer', 'mutation pin (1): code survives to storage');
  assert.equal(stored.group.httpStatus, 500);
  assert.equal(stored.group.pagesCompleted, 1);
  assert.equal(stored.namedLocation.outcome, 'complete-empty');
  assert.equal(stored.roleAssignment.outcome, 'failed');
  assert.deepEqual(stored.user, { outcome: 'not-requested', itemCount: null });

  // Write-path redaction: the digest row persisted to the database (and printed
  // by the CLI's console.table) is already redacted — a token must never reach
  // storage even though the report boundary would redact it again on read.
  assert.match(stored.group.error, /denied on page 2/, 'prose survives storage');
  assert.ok(!stored.group.error.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'no JWT segment in the stored digest');
  assert.ok(!stored.group.error.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'), 'no token signature in the stored digest');
  assert.ok(!JSON.stringify(stored).includes('Bearer eyJ'), 'no bearer value anywhere in the stored digest');

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date(),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // Mutation pin (2): the second-page failure fails completeness in the report
  // while keeping the partial count and the structured evidence.
  const group = byType.get('group');
  assert.equal(group.status, 'failed');
  assert.equal(group.covered, false);
  assert.equal(group.outcome, 'partial');
  assert.equal(group.itemCount, 2);
  assert.equal(group.detail.graphCode, 'Error_InternalServer', 'mutation pin (1): code survives to the report');
  assert.equal(group.detail.httpStatus, 500);
  assert.equal(group.detail.endpoint, '/groups?$select=id,displayName,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime,assignedLicenses');
  assert.equal(group.detail.apiVersion, 'v1.0');
  assert.equal(group.detail.pagesCompleted, 1);
  assert.ok(group.detail.startedAt && group.detail.completedAt, 'observation timestamps reach the report');

  // Mutation pin (3): the first-page denial stays failed — never complete-empty.
  const denied = byType.get('roleAssignment');
  assert.equal(denied.status, 'failed');
  assert.equal(denied.outcome, 'failed');
  assert.equal(denied.itemCount, null);
  assert.equal(denied.detail.graphCode, 'Error_AccessDenied');

  // Empty success is a strict coverage success, distinct from every failure.
  const empty = byType.get('namedLocation');
  assert.equal(empty.status, 'covered');
  assert.equal(empty.covered, true);
  assert.equal(empty.outcome, 'complete-empty');
  assert.equal(empty.itemCount, 0);

  // A not-requested mention never shadows the older genuine observation: the
  // tier2 user read from the older full run still decides, and the latest
  // run's explicit not-requested marker stays visible on types with no
  // observation at all.
  const user = byType.get('user');
  assert.equal(user.status, 'covered', 'not-requested never shadows older evidence');
  assert.equal(user.itemCount, 7);
  const contact = byType.get('contact');
  assert.equal(contact.status, 'never-collected');
  assert.equal(contact.outcome, 'not-requested', 'explicit not-requested is distinguishable from empty success');
  assert.equal(contact.covered, false);
  assert.equal(contact.detail, null, 'not-requested invents no observation evidence');

  // Codes survive the whole path; token-shaped values never do.
  const serialized = JSON.stringify(report);
  assert.ok(serialized.includes('Error_InternalServer'));
  assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'no JWT segment in the report');
  assert.ok(!serialized.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'), 'no token signature in the report');
  assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]+/.test(serialized.replaceAll('Bearer [redacted]', '')), 'no bearer value in the report');
});

test('legacy digests remain readable without inventing evidence', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:outcomes-legacy';
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, '2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z', 'complete', $2)`,
    [tenantRef, JSON.stringify({
      group: 5,
      namedLocation: { outcome: 'complete', itemCount: 0 },
      roleAssignment: { outcome: 'failed', itemCount: null, error: `denied; Bearer ${JWT}` },
    })],
  );
  const report = await buildCoverageReport(client, {
    tenantRef, catalog: [], descriptors: DESCRIPTORS.filter((d) => ['group', 'namedLocation', 'roleAssignment'].includes(d.type)),
    now: new Date('2026-09-10T11:00:00Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // Bare legacy counts: old meaning, no outcome vocabulary, no invented detail.
  const group = byType.get('group');
  assert.equal(group.status, 'covered');
  assert.equal(group.itemCount, 5);
  assert.equal(group.outcome, null);
  assert.equal(group.detail, null);

  // Legacy message-only entries keep their outcome and their message — with
  // token-shaped values redacted even though the row predates redaction.
  const denied = byType.get('roleAssignment');
  assert.equal(denied.status, 'failed');
  assert.equal(denied.outcome, 'failed');
  assert.match(denied.detail.message, /denied/);
  assert.ok(!denied.detail.message.includes('eyJ'), 'legacy messages are redacted at the report boundary');
  assert.equal(denied.detail.httpStatus, null, 'unevidenced legacy fields stay null');

  const empty = byType.get('namedLocation');
  assert.equal(empty.status, 'covered', 'legacy complete with zero items still reads covered');
  assert.equal(empty.outcome, 'complete');
});
