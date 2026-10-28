// Q45 (live operator run, 2026-10-13, test tenant): journaling gaps that
// blocked live capture. Fixtures only: a fake Graph, no tenant.
//
//  - Edge writes record their outcome: engine/roadmap/relationship-restore.test.mjs.
//  - A tenant whose GET /organization/{id}/branding answers 404 keeps its
//    default branding only as language 0. Its restore is journaled, with prior
//    state and outcome, and the live capture counts it as the default-branding
//    update.
//  - A restored Conditional Access policy no longer fails the closing sign-in
//    path gate on its own change, and every wave failure carries a reason.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyWave } from '../restore/applyEngine.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { captureLive } from '../../tools/qualification/entraLive.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const TENANT = '11111111-2222-4333-8444-555555555555';
const TEST_REFS = Object.freeze([tenantRefFor(TENANT)]);

/** A journal kept in memory, in the shape rollbackJournal.mjs writes and listJournal returns. */
function memoryJournal() {
  const rows = [];
  const client = {
    async query(sql, values) {
      if (/^\s*INSERT INTO rollback_entry/.test(sql)) {
        const [runId, naturalKey, priorState, restoreRef = null, resourceType = null, operation = null, targetId = null, blastRadius = null, intended = null, outcome = null] = values;
        const id = `entry-${rows.length + 1}`;
        rows.push({
          id, runId, naturalKey, priorState, restoreRef, resourceType, operation, targetId, blastRadius,
          intendedState: intended === null ? null : JSON.parse(intended), postState: null, outcome, outcomeDetail: null,
          recordedAt: new Date('2026-10-13T10:00:00Z'),
        });
        return { rows: [{ id }] };
      }
      if (/^\s*UPDATE rollback_entry/.test(sql)) {
        const [id, outcome, postState, targetId, detail] = values;
        const row = rows.find((entry) => entry.id === id);
        Object.assign(row, {
          outcome, outcomeDetail: detail,
          ...(postState !== null ? { postState: JSON.parse(postState) } : {}),
          ...(targetId !== null ? { targetId } : {}),
        });
        return { rows: [] };
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
  return { rows, client };
}

// ------------------------------------------------------------------ branding in language 0

const ORIGINAL = Object.freeze({ id: '0', signInPageText: 'KEEL-RT-148 original', usernameHintText: 'name@fixture.example' });
const RESTORE_REF = '0f0e0d0c-0b0a-4908-8706-050403020100';

/** The default branding restored at its language-0 route, as in a tenant whose /branding is 404. */
async function restoreLanguageZero() {
  const graph = fakeGraph();
  const path = `/organization/${TENANT}/branding/localizations/0`;
  const live = { ...ORIGINAL, signInPageText: 'KEEL-RT-148 DRIFTED' };
  graph.objects.set(path, live);
  const journal = memoryJournal();
  const result = await applyWave(graph, governor, [{
    naturalKey: 'organizationalBrandingLocalization:0', resourceType: 'organizationalBrandingLocalization', verb: 'update',
    payload: ORIGINAL, references: [], blastRadius: 'cosmetic', targetId: '0', live: { state: 'present', targetId: '0', payload: live },
  }], { targetTenant: TENANT, mode: 'enforce', rollbackClient: journal.client, runId: 'run-q45', restoreRef: RESTORE_REF });
  return { graph, path, result, journal };
}

test('Q45: the default branding at language 0 is journaled with its prior state and a verified outcome', async () => {
  const { graph, path, result, journal } = await restoreLanguageZero();
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.equal(graph.objects.get(path).signInPageText, 'KEEL-RT-148 original');
  assert.equal(journal.rows.length, 1, 'one journal entry for the one write');
  const [entry] = journal.rows;
  assert.equal(entry.restoreRef, RESTORE_REF);
  assert.equal(entry.operation, 'update');
  assert.equal(entry.priorState.signInPageText, 'KEEL-RT-148 DRIFTED');
  assert.equal(entry.outcome, 'succeeded');
  assert.equal(entry.outcomeDetail, null);
  assert.equal(entry.postState.signInPageText, 'KEEL-RT-148 original');
});

test('Q45: the live capture of the default-branding update finds the language-0 write', async () => {
  const { journal } = await restoreLanguageZero();
  const capture = (resourceType, fixture) => captureLive({
    client: {}, restoreRef: RESTORE_REF, resourceType, operation: 'update', fixture,
    targetConfig: { tenantId: TENANT }, build: 'abc1234', hmacKey: 'fixture-only-hmac-key', allowTenantSetting: true, testTenantRefs: TEST_REFS,
    getArtifact: async (_client, { id }) => (id === RESTORE_REF
      ? { id, tenantRef: TEST_REFS[0], targetTenantId: TENANT, snapshotId: 'snapshot-q45', conditionalAccessEnforcement: null }
      : null),
    getJournal: async () => journal.rows,
    getSnapshot: async () => ({ versions: [], references: [] }),
  });
  for (const fixture of ['organizationalBranding', 'organizationalBranding:organizationalBranding']) {
    const result = await capture('organizationalBranding', fixture);
    assert.equal(result.status, 'captured', `${fixture}: ${result.reason ?? ''}`);
    assert.equal(result.record.resourceType, 'organizationalBranding');
    // The capture log still says exactly what was written, and where.
    const log = JSON.parse(result.captureLog);
    assert.equal(log.entry.resourceType, 'organizationalBrandingLocalization');
    assert.equal(log.entry.naturalKey, 'organizationalBrandingLocalization:0');
  }
  // The same write still counts as the language update under its own key.
  assert.equal((await capture('organizationalBrandingLocalization', 'organizationalBrandingLocalization:0')).status, 'captured');
  // Another language is never taken for the default branding.
  journal.rows[0].naturalKey = 'organizationalBrandingLocalization:fr-FR';
  journal.rows[0].targetId = 'fr-FR';
  assert.equal((await capture('organizationalBranding', 'organizationalBranding')).status, 'not-exercised');
});

// ------------------------------------------------------------------ Conditional Access and the sign-in path gate

const POLICIES = '/identity/conditionalAccess/policies';
const POLICY = Object.freeze({
  displayName: 'KEEL-RT-148-ca', state: 'enabledForReportingButNotEnforced',
  conditions: { users: { includeUsers: ['None'] }, applications: { includeApplications: ['None'] } },
  grantControls: { operator: 'OR', builtInControls: ['block'] },
});
const BREAK_GLASS = 'break-glass-id';

/**
 * The read-only sign-in path reader, over the same fake tenant the writer
 * changes. `onAfterRead(items)` may alter what the closing read (the second
 * one) sees.
 */
function signInReader(graph, { onAfterRead = null } = {}) {
  let policyReads = 0;
  return {
    async collect(_version, path) {
      if (path === POLICIES) {
        policyReads += 1;
        const items = [...graph.objects.entries()]
          .filter(([key]) => key.startsWith(`${POLICIES}/`))
          .map(([key, body]) => ({ ...body, id: key.slice(POLICIES.length + 1) }));
        return { items: policyReads > 1 && onAfterRead ? onAfterRead(items) : items, capped: false, error: null };
      }
      if (path.startsWith('/roleManagement/directory/roleAssignments?')) {
        return { items: [{ id: 'role-1', principalId: BREAK_GLASS, roleDefinitionId: 'global-admin', directoryScopeId: '/' }], capped: false, error: null };
      }
      if (path === '/identity/conditionalAccess/namedLocations') return { items: [], capped: false, error: null };
      throw new Error(`unexpected collection ${path}`);
    },
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: BREAK_GLASS, accountEnabled: true } };
      throw new Error(`unexpected read ${path}`);
    },
  };
}

async function restorePolicy({ onAfterRead = null } = {}) {
  const graph = fakeGraph();
  const live = { ...POLICY, id: 'ca-fixture', displayName: 'KEEL-RT-148-ca drifted' };
  graph.objects.set(`${POLICIES}/ca-fixture`, live);
  graph.objects.set(`${POLICIES}/ca-other`, { ...POLICY, displayName: 'Protect admins', state: 'enabled' });
  const journal = memoryJournal();
  const result = await applyWave(graph, governor, [{
    naturalKey: 'conditionalAccessPolicy:KEEL-RT-148-ca', resourceType: 'conditionalAccessPolicy', verb: 'update', payload: POLICY,
    references: [], blastRadius: 'access-affecting', targetId: 'ca-fixture', live: { state: 'present', targetId: 'ca-fixture', payload: live },
  }], {
    targetTenant: TENANT, mode: 'enforce', rollbackClient: journal.client, runId: 'run-q45-ca', restoreRef: RESTORE_REF,
    signInPathGate: { reader: signInReader(graph, { onAfterRead }), protectedPrincipalIds: [BREAK_GLASS] },
  });
  return { graph, result, journal };
}

test('Q45: a verified report-only policy restore does not fail the sign-in path gate on its own change', async () => {
  const { graph, result, journal } = await restorePolicy();
  assert.equal(graph.objects.get(`${POLICIES}/ca-fixture`).displayName, 'KEEL-RT-148-ca');
  assert.deepEqual(result.failed, [], 'the wave counts no failure its journal does not show');
  assert.equal(result.applied.length, 1);
  assert.equal(journal.rows.length, 1);
  assert.equal(journal.rows[0].outcome, 'succeeded');
});

test('mutation: any other sign-in path change during a policy restore still fails the gate, with a reason', async () => {
  // Another, enforcing policy changes while the restore runs.
  const { result } = await restorePolicy({
    onAfterRead: (items) => items.map((item) => (item.id === 'ca-other' ? { ...item, grantControls: { operator: 'OR', builtInControls: ['mfa'] } } : item)),
  });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.failed, [{
    naturalKey: 'sign-in-path-gate', error: 'sign-in path changed: conditionalAccessPolicies', changed: ['conditionalAccessPolicies'],
  }]);
});

test('mutation: a restored policy that reads back enforcing at the gate is not left out of it', async () => {
  const { result } = await restorePolicy({
    onAfterRead: (items) => items.map((item) => (item.id === 'ca-fixture' ? { ...item, state: 'enabled' } : item)),
  });
  assert.deepEqual(result.failed.map((entry) => entry.naturalKey), ['sign-in-path-gate']);
});
