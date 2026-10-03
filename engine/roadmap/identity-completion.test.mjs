/**
 * Roadmap task-65 boundary tests: credential and service recovery completion.
 *
 * Exercises engine/restore/completion.mjs against the isolated test database
 * and the full cli/keel-restore.mjs promotion path against an in-memory fake
 * Graph. No tenant is read or written. Required mutation checks:
 *
 * - Mark recreate fully complete immediately.
 * - Allow unauthenticated completion.
 * - Persist supplied secret value.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole, revokeRole, disablePrincipal } from '../authz/administration.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import {
  CompletionAuthorizationError, CompletionEvidenceError, completeItem, completionItemsFor, emitCompletionItems,
  listCompletionItems, reopenItem, resourceCompletionState, summarizeCompletion, validateCompletionEvidence,
} from '../restore/completion.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

// An Entra-shaped client secret. It must never be stored, logged or emitted.
const SENTINEL = 'Xk38Q~KEELsentinelDoNotPersist0123456789ab';
const TENANT = 'sha256:task-65';

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

async function principal(client, email, role) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  const grant = role ? await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id }) : null;
  return { id: rows[0].id, grantId: grant?.id ?? null };
}

const recreatedApp = { naturalKey: 'application:Payroll connector', resourceType: 'application', mechanism: 'recreate' };
let refCounter = 0;
const nextRef = () => `65000000-0000-4000-8000-${String(++refCounter).padStart(12, '0')}`;
const evidence = (reference = 'CHG-5120') => ({ type: 'ticket', reference });

// ------------------------------------- acceptance 1 + mutation check: never complete at once

test('mutation check: a recreated object is never complete immediately; the app stays pending until evidence', async (t) => {
  const client = await schemaClient(t);
  const operator = await principal(client, 'op1@contoso.example', 'restorer');
  const kinds = completionItemsFor(recreatedApp).map((item) => item.kind);
  assert.deepEqual(kinds, ['credential', 'certificate', 'consent', 'integration', 'service-validation']);
  for (const resourceType of ['group', 'namedLocation', 'conditionalAccessPolicy', 'roleAssignment']) {
    const items = completionItemsFor({ resourceType, mechanism: 'recreate' });
    assert.ok(items.some((item) => item.kind === 'integration') && items.some((item) => item.kind === 'service-validation'), resourceType);
  }
  assert.deepEqual(completionItemsFor({ resourceType: 'group', mechanism: 'update-existing' }), [], 'an in-place update leaves nothing to complete');

  const restoreRef = nextRef();
  const items = await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: operator.id, applied: [recreatedApp] });
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.state === 'pending' && item.owner === operator.id));
  assert.equal(resourceCompletionState(items), 'configuration-restored');

  for (const item of items.filter((entry) => entry.kind !== 'service-validation')) {
    await completeItem(client, { tenantRef: TENANT, itemId: item.id, actorId: operator.id, evidence: evidence(`CHG-${item.requirement}`) });
  }
  let summary = summarizeCompletion(await listCompletionItems(client, { tenantRef: TENANT, restoreRef }));
  assert.equal(summary[0].state, 'service-validation-pending', 'configuration items closed, service check still open');

  const validation = items.find((entry) => entry.kind === 'service-validation');
  await completeItem(client, { tenantRef: TENANT, itemId: validation.id, actorId: operator.id, evidence: { type: 'log-reference', reference: 'signin-log:7d1e' } });
  summary = summarizeCompletion(await listCompletionItems(client, { tenantRef: TENANT, restoreRef }));
  assert.equal(summary[0].state, 'verified-complete');

  // Reopening is always possible and moves the resource back.
  await reopenItem(client, { tenantRef: TENANT, itemId: validation.id, actorId: operator.id, reason: 'sign-ins failing again' });
  summary = summarizeCompletion(await listCompletionItems(client, { tenantRef: TENANT, restoreRef }));
  assert.equal(summary[0].state, 'service-validation-pending');
  assert.equal(summary[0].items.find((item) => item.id === validation.id).reopenCount, 1);
});

// ------------------------------------------------------------ acceptance 2: idempotency

test('duplicate completion and duplicate emission are idempotent', async (t) => {
  const client = await schemaClient(t);
  const operator = await principal(client, 'op2@contoso.example', 'restorer');
  const restoreRef = nextRef();
  const [first] = await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: operator.id, applied: [recreatedApp] });
  assert.deepEqual(await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: operator.id, applied: [recreatedApp] }), [], 'a retried run emits nothing new');
  assert.equal((await listCompletionItems(client, { tenantRef: TENANT, restoreRef })).length, 5);

  const once = await completeItem(client, { tenantRef: TENANT, itemId: first.id, actorId: operator.id, evidence: evidence() });
  const twice = await completeItem(client, { tenantRef: TENANT, itemId: first.id, actorId: operator.id, evidence: evidence('CHG-other') });
  assert.equal(once.changed, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.item.evidence.length, 1, 'the second close adds no evidence');
  const events = await client.query(`SELECT * FROM recovery_completion_event WHERE item_id = $1`, [first.id]);
  assert.equal(events.rows.length, 1);
});

// ------------------------------------ acceptance 3 + mutation check: current authority only

test('mutation check: revoked, disabled, read-only and unauthenticated actors cannot close or reopen an item', async (t) => {
  const client = await schemaClient(t);
  const revoked = await principal(client, 'revoked@contoso.example', 'restorer');
  const disabled = await principal(client, 'disabled@contoso.example', 'restorer');
  const viewer = await principal(client, 'viewer@contoso.example', 'viewer');
  const restoreRef = nextRef();
  const [item] = await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: revoked.id, applied: [recreatedApp] });

  await revokeRole(client, { principalId: revoked.id, grantId: revoked.grantId, revokedBy: viewer.id });
  await disablePrincipal(client, disabled.id);
  for (const actorId of [revoked.id, disabled.id, viewer.id, null, undefined, '', 'not-a-principal']) {
    await assert.rejects(
      completeItem(client, { tenantRef: TENANT, itemId: item.id, actorId, evidence: evidence() }),
      CompletionAuthorizationError,
      `actor ${actorId} must be refused`,
    );
  }
  const after = await listCompletionItems(client, { tenantRef: TENANT, restoreRef });
  assert.ok(after.every((entry) => entry.state === 'pending'), 'nothing was closed');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM recovery_completion_event WHERE item_id = $1`, [item.id])).rows[0].n, 0, 'no transition was recorded');

  // Another tenant's item is not found, never closable across tenants.
  const operator = await principal(client, 'op3@contoso.example', 'restorer');
  await assert.rejects(completeItem(client, { tenantRef: 'sha256:other', itemId: item.id, actorId: operator.id, evidence: evidence() }), /not found/);
  // Evidence is required: a bare close is refused before authorization even runs.
  await assert.rejects(completeItem(client, { tenantRef: TENANT, itemId: item.id, actorId: operator.id }), CompletionEvidenceError);
});

// --------------------------------- acceptance 4 + mutation check: the secret is never kept

test('mutation check: a supplied secret is refused and never appears in rows, evidence, events or logs', async (t) => {
  const client = await schemaClient(t);
  const operator = await principal(client, 'op4@contoso.example', 'restorer');
  const restoreRef = nextRef();
  const items = await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: operator.id, applied: [recreatedApp] });
  const credential = items.find((item) => item.kind === 'credential');

  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args.join(' ')); };
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    for (const bad of [
      { type: 'ticket', reference: 'CHG-1', secretText: SENTINEL },
      { type: 'ticket', reference: 'CHG-1', value: SENTINEL },
      { type: 'ticket', reference: SENTINEL },
      { type: 'attestation', reference: 'CHG-1', note: `rotated to ${SENTINEL}` },
      { type: 'ticket', reference: '-----BEGIN PRIVATE KEY----- MIIE' },
    ]) {
      await assert.rejects(completeItem(client, { tenantRef: TENANT, itemId: credential.id, actorId: operator.id, evidence: bad }), CompletionEvidenceError);
    }
    await assert.rejects(reopenItem(client, { tenantRef: TENANT, itemId: credential.id, actorId: operator.id, reason: SENTINEL }), CompletionEvidenceError);
    await completeItem(client, { tenantRef: TENANT, itemId: credential.id, actorId: operator.id, evidence: { type: 'ticket', reference: 'CHG-5555', note: 'secret rotated in the vault' } });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const dump = JSON.stringify([
    (await client.query(`SELECT * FROM recovery_completion_item`)).rows,
    (await client.query(`SELECT * FROM recovery_completion_event`)).rows,
    (await client.query(`SELECT * FROM evidence`)).rows,
  ]);
  assert.ok(!dump.includes(SENTINEL), 'no table holds the secret');
  assert.ok(!dump.includes('BEGIN PRIVATE KEY'), 'no table holds key material');
  assert.ok(!logged.join('\n').includes(SENTINEL), 'no log or event-stream line carries the secret');
  assert.ok(dump.includes('CHG-5555'), 'the evidence reference itself is kept');
  assert.equal(validateCompletionEvidence({ type: 'link', reference: ' https://tickets.example/CHG-1 ' }).reference, 'https://tickets.example/CHG-1');
});

// --------------------------------------------- full CLI: promotion emits completion items

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-65', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-65', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();
const finance = { displayName: 'Finance approvers', mailNickname: 'finance-approvers', mailEnabled: false, securityEnabled: true, groupTypes: [] };

function cliDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/directory/deletedItems/')) return { items: [], capped: false, error: null };
      if (path.startsWith('/groups')) {
        return { items: [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body), capped: false, error: null };
      }
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
    ],
  };
}

test('an enforced promotion that recreates a group opens owned completion items keyed by the artifact', async (t) => {
  const client = await schemaClient(t);
  const operator = await principal(client, 'op5@contoso.example', 'restorer');
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:finance-approvers', resourceType: 'group', payload: finance, payloadHash: canonicalHash(finance, 'group'),
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });

  const graph = fakeGraph();
  const artifactId = nextRef();
  const logs = [];
  const logger = { log: (line) => logs.push(line), error: (line) => logs.push(String(line)) };
  await runRestore({
    snapshotId, selection: ['group:finance-approvers'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy: operator.id,
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
    readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger,
  });
  assert.deepEqual(await listCompletionItems(client, { tenantRef: TENANT, restoreRef: artifactId }), [], 'a dry run opens nothing');

  const result = await runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger });
  assert.deepEqual(result.results.failed, []);
  assert.ok(graph.writes.some((write) => write.method === 'POST' && write.path === '/groups'), 'the group was recreated');
  const items = await listCompletionItems(client, { tenantRef: TENANT, restoreRef: artifactId });
  assert.deepEqual(items.map((item) => item.kind), ['integration', 'service-validation']);
  assert.ok(items.every((item) => item.owner === operator.id && item.state === 'pending'));
  assert.equal(result.completionItems.length, 2);
  assert.equal(summarizeCompletion(items)[0].state, 'configuration-restored');
});
