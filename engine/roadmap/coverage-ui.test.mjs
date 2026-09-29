/** Task-54 boundary coverage: real engine reports in an isolated database,
 * followed by the real portal loader, request authorization and page render.
 * No live Microsoft calls or writers are used.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { buildCoverageReport, reportObservationWindows } from '../coverage/report.mjs';
import { assertSimultaneous } from '../contracts/observation.mjs';
import { SERVER_OWNED, SERVER_OWNED_ALWAYS } from '../cir/serverOwned.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

// A single reader exercising every M1 type plus the consent evidence
// roleAssignment's registered prerequisite depends on: group succeeds,
// roleAssignment is denied with a 403 (authorization-shaped, diagnosable),
// namedLocation succeeds empty (complete-empty, zero pages of evidence to
// hide), conditionalAccessPolicy/authenticationStrengthPolicy succeed, and
// oauth2PermissionGrant succeeds with a scope that does NOT satisfy
// roleAssignment's prerequisite — confirming missing-scope, never masking
// the raw 403 as something else.
const reader = {
  async collect(_version, path) {
    if (path.startsWith('/groups?')) {
      return { items: [{ id: 'g1', mailNickname: 'group-1' }], pages: 1, status: 200, error: null };
    }
    if (path === '/roleManagement/directory/roleAssignments') {
      return { items: [], pages: 0, error: { status: 403, code: 'Error_AccessDenied', error: 'denied' } };
    }
    if (path === '/identity/conditionalAccess/namedLocations') {
      return { items: [], pages: 1, status: 200, error: null };
    }
    if (path === '/identity/conditionalAccess/policies') {
      return { items: [{ id: 'cap1', displayName: 'Block legacy auth' }], pages: 1, status: 200, error: null };
    }
    if (path === '/policies/authenticationStrengthPolicies') {
      return { items: [{ id: 'asp1', displayName: 'MFA required' }], pages: 1, status: 200, error: null };
    }
    if (path === '/oauth2PermissionGrants') {
      return { items: [{ id: 'grant1', clientId: 'c1', scope: 'User.Read Mail.Read' }], pages: 1, status: 200, error: null };
    }
    return { items: [], pages: 1, status: 200, error: null };
  },
};

test('coverage report: declared endpoint, irrecoverable fields and relationship completeness for the six M1 types', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:coverage-ui-m1';

  await collectSnapshot(client, { reader, tenantRef, tenantId: 'fixture-tenant', tier: 'tier1' });
  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date(),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  // Declared endpoint/version (from the catalog) is present even for a type
  // this run never requested — distinct from the measured endpoint, which
  // only exists once an observation actually carried it.
  const user = byType.get('user');
  assert.equal(user.status, 'never-collected', 'user is tier2, excluded from a tier1-only run');
  assert.deepEqual(user.declaredEndpoint, { path: '/users', apiVersion: 'v1.0' });
  assert.equal(user.detail, null, 'no observation exists yet — pagination evidence is unknown, never invented');

  const group = byType.get('group');
  // Mutation pin: the declared endpoint is the bare catalog path, never
  // conflated with the measured (select-qualified) endpoint that survived
  // collection — collapsing the two would hide that "declared" predates and
  // outlives any single measurement.
  assert.deepEqual(group.declaredEndpoint, { path: '/groups', apiVersion: 'v1.0' });
  assert.ok(group.detail.endpoint.startsWith('/groups?$select='), 'measured endpoint carries the real query');
  assert.notEqual(group.declaredEndpoint.path, group.detail.endpoint);

  // Irrecoverable fields reuse engine/cir/serverOwned.mjs's existing
  // registry verbatim — never re-derived — so a "full" fidelity badge still
  // names exactly the fields Graph owns and no write path can restore.
  const expectedGroupIrrecoverable = [...new Set([...SERVER_OWNED_ALWAYS, ...SERVER_OWNED.get('group')])].sort();
  assert.deepEqual(group.irrecoverableFields, expectedGroupIrrecoverable);
  assert.equal(group.fidelity.declared, 'full');
  assert.ok(group.irrecoverableFields.length > 0, 'a full-fidelity badge still discloses fields it cannot recover');

  const namedLocation = byType.get('namedLocation');
  assert.deepEqual(namedLocation.irrecoverableFields, [...SERVER_OWNED_ALWAYS].sort(),
    'namedLocation has no type-specific server-owned fields — only the universal ones');
  assert.equal(namedLocation.status, 'covered');
  assert.equal(namedLocation.outcome, 'complete-empty');
  // Mutation pin: pagination evidence is a known zero, never dropped to
  // null or silently conflated with "unknown" (user.detail above).
  assert.equal(namedLocation.detail.pagesCompleted, 1);

  const roleAssignment = byType.get('roleAssignment');
  assert.equal(roleAssignment.status, 'failed');
  // A first-page 403 completed zero pages — a KNOWN zero, distinct from the
  // unknown (null) pagination state on a type with no observation at all.
  assert.equal(roleAssignment.detail.pagesCompleted, 0);
  assert.notEqual(roleAssignment.detail.pagesCompleted, null);

  // Prerequisite diagnosis (task-53) surfaces through unmodified: the 403 is
  // confirmed as a missing consent scope from the same run's
  // oauth2PermissionGrant evidence, which grants scopes that do not include
  // the one roleAssignment's prerequisite requires.
  assert.equal(roleAssignment.diagnosis.diagnosis, 'missing-scope');
  assert.equal(roleAssignment.diagnosis.original.httpStatus, 403);
  assert.deepEqual(roleAssignment.diagnosis.confirmed.consentScopes, ['RoleManagement.Read.Directory']);

  // Relationship completeness is honestly unknown for every type — no
  // relationship/edge collection exists yet (roadmap task-57/58).
  for (const entry of report.types) {
    assert.equal(entry.relationshipCompleteness, 'unknown', `${entry.type}: relationship completeness is not fabricated`);
  }

  // Operation-specific write-capability status passes through the existing
  // registry's exact claim strings — group is registered and fixture-tested;
  // user and authenticationStrengthPolicy were never registered at all.
  // Mutation pin: a claim collapse (e.g. any registered claim rendered as a
  // generic "verified") would still pass a loose truthy check but fail this
  // exact string comparison.
  assert.equal(group.writeCapability.operations.update.claim, 'fixture-tested');
  assert.notEqual(group.writeCapability.operations.update.claim, 'live-qualified');
  assert.equal(group.writeCapability.operations['restore-soft-deleted'].claim, 'fixture-tested');
  assert.equal(user.writeCapability.operations.create.claim, 'unsupported');
  assert.equal(byType.get('authenticationStrengthPolicy').writeCapability.operations.update.claim, 'unsupported');

  // A catalog entry with no collecting descriptor still gets the honest
  // not-covered fields, never left undefined.
  const extendedCatalog = [...CATALOG, {
    type: 'zzNoDescriptorFixture', path: '/zzNoDescriptorFixture', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'cosmetic',
  }];
  const extendedReport = await buildCoverageReport(client, {
    tenantRef, catalog: extendedCatalog, descriptors: DESCRIPTORS, now: new Date(),
  });
  const notCovered = extendedReport.types.find((entry) => entry.type === 'zzNoDescriptorFixture');
  assert.equal(notCovered.status, 'not-covered');
  assert.deepEqual(notCovered.declaredEndpoint, { path: '/zzNoDescriptorFixture', apiVersion: 'v1.0' });
  assert.equal(notCovered.irrecoverableFields, null, 'no field-classification registry entry exists for an uncollected type');
  assert.equal(notCovered.relationshipCompleteness, 'unknown');
});

test('coverage report: cross-tier observation windows are surfaced as an explicit mismatch, never merged silently', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:coverage-ui-mismatch';

  const setSnapshotTimes = async (id, startedAt, completedAt) => client.query(
    'UPDATE snapshot SET started_at = $2, completed_at = $3 WHERE id = $1',
    [id, startedAt, completedAt],
  );
  const setDigestWindow = async (id, startedAt, completedAt) => {
    const { rows } = await client.query('SELECT coverage_digest FROM snapshot WHERE id = $1', [id]);
    const digest = Object.fromEntries(Object.entries(rows[0].coverage_digest).map(([type, entry]) => [
      type,
      entry && typeof entry === 'object' && 'startedAt' in entry ? { ...entry, startedAt, completedAt } : entry,
    ]));
    await client.query('UPDATE snapshot SET coverage_digest = $2 WHERE id = $1', [id, JSON.stringify(digest)]);
  };

  const tier1 = await collectSnapshot(client, { reader, tenantRef, tenantId: 'fixture-tenant', tier: 'tier1' });
  await setSnapshotTimes(tier1.snapshotId, '2026-09-20T08:00:00Z', '2026-09-20T08:05:00Z');
  await setDigestWindow(tier1.snapshotId, '2026-09-20T08:00:00Z', '2026-09-20T08:05:00Z');

  const tier2 = await collectSnapshot(client, { reader, tenantRef, tenantId: 'fixture-tenant', tier: 'tier2' });
  await setSnapshotTimes(tier2.snapshotId, '2026-09-20T09:00:00Z', '2026-09-20T09:05:00Z');
  await setDigestWindow(tier2.snapshotId, '2026-09-20T09:00:00Z', '2026-09-20T09:05:00Z');

  const report = await buildCoverageReport(client, {
    tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-20T09:10:00Z'),
  });
  const byType = new Map(report.types.map((entry) => [entry.type, entry]));

  const user = byType.get('user');
  const group = byType.get('group');
  assert.equal(user.status, 'covered', 'the tier2 run collected user');
  assert.deepEqual(user.observation.window, {
    startedAt: '2026-09-20T09:00:00.000Z', endedAt: '2026-09-20T09:05:00.000Z',
  });
  assert.deepEqual(group.observation.window, {
    startedAt: '2026-09-20T08:00:00.000Z', endedAt: '2026-09-20T08:05:00.000Z',
  });

  // Mutation pin: reportObservationWindows() (task-45, reused verbatim here)
  // must never merge the two runs' distinct windows into one group — group
  // and user are named under their own separate windows, and assertSimultaneous
  // over the two confirms the explicit mismatch rather than hiding it.
  const windows = reportObservationWindows(report);
  assert.ok(windows.get('2026-09-20T08:00:00.000Z/2026-09-20T08:05:00.000Z').includes('group'));
  assert.ok(windows.get('2026-09-20T09:00:00.000Z/2026-09-20T09:05:00.000Z').includes('user'));
  assert.ok(!windows.get('2026-09-20T08:00:00.000Z/2026-09-20T08:05:00.000Z').includes('user'));
  const consistency = assertSimultaneous([group.observation, user.observation]);
  assert.equal(consistency.simultaneous, false);
  assert.equal(consistency.mismatches[0].reason, 'window-mismatch');
});

// Exercise the real TS loader and page in a separate portal runtime. Only its
// database URL and tenant config are replaced; no normalization/render seam is mocked.
test('coverage portal: report survives normalization, authorization and page rendering', async (t) => {
  const client = await database.connect();
  t.after(() => client.end());
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantId = 'coverage-portal-fixture';
  const tenantRef = `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
  const collected = await collectSnapshot(client, { reader, tenantRef, tenantId, tier: 'tier1' });
  // Pin one distinct window: fast fixture reads can otherwise share a millisecond.
  await client.query(`UPDATE snapshot SET coverage_digest = jsonb_set(
    jsonb_set(coverage_digest, '{group,startedAt}', '"2026-09-20T08:00:00.000Z"'),
    '{group,completedAt}', '"2026-09-20T08:05:00.000Z"') WHERE id = $1`, [collected.snapshotId]);
  await client.query("UPDATE snapshot SET coverage_digest = coverage_digest #- '{group,pagesCompleted}' WHERE id = $1", [collected.snapshotId]);
  const directory = mkdtempSync(join(tmpdir(), 'keel-coverage-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'tenant.json');
  writeFileSync(config, JSON.stringify({ tenantId }));
  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { renderToStaticMarkup } = require('react-dom/server');
    const { getCoverageData } = require('./lib/portal-data.ts');
    const page = require('./app/coverage/page.tsx').default;
    const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external.js');
    const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external.js');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const render = (headers) => workAsyncStorage.run({ route: '/coverage', forceStatic: false }, () =>
      workUnitAsyncStorage.run({ type: 'request', phase: 'render', headers,
        implicitTags: [], url: { pathname: '/coverage', search: '' }, rootParams: {},
        resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
      }, () => page()));
    (async () => {
      let reads = 0;
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (path === process.env.KEEL_TENANT_CONFIG_PATH) reads++;
        return originalRead.call(this, path, ...args);
      };
      for (const headers of [new Headers(), new Headers([[CAPABILITIES_HEADER, 'read']]),
        new Headers([[PRINCIPAL_ID_HEADER, 'viewer'], [CAPABILITIES_HEADER, 'collect']])]) {
        await assert.rejects(render(headers), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;403');
        assert.equal(reads, 0, 'denied coverage requests must not fetch');
      }
      const data = await getCoverageData();
      const group = data.types.find(item => item.type === 'group');
      assert.equal(group.writeCapability.operations.update.claim, 'fixture-tested');
      assert.equal(group.detail.pagesCompleted, null, 'legacy pagination stays unknown');
      assert.equal(group.writeCapability.operations.update.proofRef, 'engine/restore/updatePath.test.mjs');
      assert.equal(data.types.find(item => item.type === 'user').detail, null);
      assert.equal(data.types.find(item => item.type === 'namedLocation').reportStatus, 'covered');
      const html = renderToStaticMarkup(await render(new Headers([
        [PRINCIPAL_ID_HEADER, 'viewer'], [CAPABILITIES_HEADER, 'read']])));
      assert.ok(reads > 0, 'authorized positive control reaches the loader');
      assert.equal((html.match(/<details class="capability-matrix"/g) || []).length, data.types.length);
      for (const item of data.types) {
        assert.ok(html.includes(item.type));
        if (item.observation) assert.ok(html.includes(item.observation.observationId));
      }
      assert.match(html, /claim-fixture-tested/);
      assert.doesNotMatch(html, /claim-live-qualified/);
      assert.match(html, /Pagination evidence<\/dt><dd><span class="muted-value">Unknown/);
      assert.match(html, /Relationship completeness/);
      assert.match(html, /engine\/restore\/updatePath.test.mjs/);
      assert.match(html, /Projection review/);
      assert.match(html, /Observation windows differ/);
      assert.match(html, /observationId=/);
      assert.match(html, /completed zero-item collection is successful/);
      assert.doesNotMatch(html, /Zero-item collections are FAILED/);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: database.url, KEEL_TENANT_CONFIG_PATH: config,
      __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
