// Automatic rules can be edited and deleted (engine/policy/evaluate.mjs updatePolicy,
// deletePolicy). A deleted rule is kept as history but no reader of current rules,
// and no evaluation, sees it.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  createPolicy, deletePolicy, evaluateDrift, getPolicy, listPolicies, setPolicyEnabled, clearPolicyPause, updatePolicy,
} from './evaluate.mjs';
import { assertExecutableAutomationPolicy } from './execute.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(schemaSql());
  const tenantRef = 'sha256:policy-edit-delete-test';
  const { rows: [runAs] } = await client.query(
    "INSERT INTO principal (email, display_name) VALUES ('edit-run-as@example.com', 'Run as') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by, reason) VALUES ($1, 'restorer', 'test', 'edit test')", [runAs.id]);

  // Edit: every field is replaced, a cleared limit is saved as no limit, what it does stays.
  const alert = await createPolicy(client, {
    tenantRef, name: 'Alert on groups', resourceType: 'group', action: 'alert', maxBlastRadius: 'cosmetic',
    maxActionsPerWindow: 50, windowSeconds: 3600, createdBy: 'admin',
  });
  const edited = await updatePolicy(client, {
    tenantRef, policyId: alert.id, name: '  Alert on FIN users  ', resourceType: 'user', naturalKeyGlob: 'user:FIN-*',
    changeType: 'modified', blastRadius: 'access-affecting', maxBlastRadius: 'access-affecting',
    maxActionsPerWindow: null, windowSeconds: null, actor: 'admin',
  });
  assert.equal(edited.name, 'Alert on FIN users');
  assert.equal(edited.resource_type, 'user');
  assert.equal(edited.natural_key_glob, 'user:FIN-*');
  assert.equal(edited.change_type, 'modified');
  assert.equal(edited.blast_radius, 'access-affecting');
  assert.equal(edited.max_blast_radius, 'access-affecting');
  assert.equal(edited.max_actions_per_window, null, 'a cleared limit is saved as no limit');
  assert.equal(edited.action, 'alert', 'an edit never changes what the rule does');
  assert.equal(edited.enabled, true, 'editing an alert rule leaves it on');
  const relimited = await updatePolicy(client, { tenantRef, policyId: alert.id, name: 'Alert on FIN users', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 50, windowSeconds: 3600, actor: 'admin' });
  assert.equal(relimited.max_actions_per_window, 50);
  assert.equal(relimited.resource_type, null, 'a field left out of an edit is cleared, not kept');

  // Each edit leaves one audit record naming the settings it changed, old and new.
  const changes = async () => (await client.query(
    "SELECT subject, actor FROM evidence WHERE kind = 'policy-change' AND tenant_ref = $1 ORDER BY seq", [tenantRef],
  )).rows;
  const [firstEdit, secondEdit] = await changes();
  assert.equal(firstEdit.actor, 'admin');
  assert.equal(firstEdit.subject.change, 'edited');
  assert.equal(firstEdit.subject.policyId, String(alert.id));
  assert.equal(firstEdit.subject.name, 'Alert on FIN users');
  assert.deepEqual(firstEdit.subject.fields, [
    { field: 'name', before: 'Alert on groups', after: 'Alert on FIN users' },
    { field: 'resourceType', before: 'group', after: 'user' },
    { field: 'naturalKeyGlob', before: null, after: 'user:FIN-*' },
    { field: 'changeType', before: null, after: 'modified' },
    { field: 'blastRadius', before: null, after: 'access-affecting' },
    { field: 'maxBlastRadius', before: 'cosmetic', after: 'access-affecting' },
    { field: 'maxActionsPerWindow', before: 50, after: null },
    { field: 'windowSeconds', before: 3600, after: null },
  ]);
  assert.deepEqual(secondEdit.subject.fields.map((entry) => entry.field), [
    'resourceType', 'naturalKeyGlob', 'changeType', 'blastRadius', 'maxBlastRadius', 'maxActionsPerWindow', 'windowSeconds',
  ], 'only what changed is recorded; the limit records its count and window together');
  const unchanged = await updatePolicy(client, { tenantRef, policyId: alert.id, name: 'Alert on FIN users', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 50, windowSeconds: 3600, actor: 'admin' });
  assert.equal(unchanged.max_actions_per_window, 50);
  assert.equal((await changes()).length, 2, 'an edit that changes nothing records nothing');
  await updatePolicy(client, { tenantRef, policyId: alert.id, name: 'Alert on FIN users', resourceType: '', naturalKeyGlob: '', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 50, windowSeconds: 3600, actor: 'admin' });
  assert.equal((await changes()).length, 2, 'an empty value is the same as none, not a change');
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: 'x', maxBlastRadius: 'cosmetic' }), /needs an actor/);

  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: ' ', maxBlastRadius: 'cosmetic', actor: 'admin' }), /name is required/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: 'x', maxBlastRadius: 'huge', actor: 'admin' }), /invalid max blast radius/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: 'x', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 5, actor: 'admin' }), /both a count and a window/);
  await assert.rejects(updatePolicy(client, { tenantRef: 'sha256:other', policyId: alert.id, name: 'x', maxBlastRadius: 'cosmetic', actor: 'admin' }), /not found/, 'another tenant cannot edit it');

  // Editing an undo rule that is on turns it off: its activation preview was for the old scope.
  const undo = await createPolicy(client, {
    tenantRef, name: 'Undo low risk', action: 'auto_remediate', maxBlastRadius: 'cosmetic', enabled: true,
    createdBy: 'admin', runAsPrincipalId: runAs.id,
  });
  assert.equal(undo.enabled, true);
  const undoEdited = await updatePolicy(client, { tenantRef, policyId: undo.id, name: 'Undo low risk groups', resourceType: 'group', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 10, windowSeconds: 3600, actor: 'admin' });
  assert.equal(undoEdited.enabled, false, 'an edited undo rule is off until previewed again');
  assert.equal(String(undoEdited.run_as_principal_id), String(runAs.id), 'the account it acts as is kept');
  const undoRecord = (await changes()).at(-1);
  assert.deepEqual(undoRecord.subject.fields.at(-1), { field: 'enabled', before: true, after: false }, 'the record says the edit turned the rule off');

  // The record and the change commit together: if the change fails, no record is left.
  const failing = await createPolicy(client, { tenantRef, name: 'Fails', action: 'alert', maxBlastRadius: 'cosmetic', createdBy: 'admin' });
  const recordsBefore = (await changes()).length;
  const realQuery = client.query.bind(client);
  client.query = async (text, values) => {
    if (/^\s*UPDATE policy\s+SET (name = \$2|enabled = false, deleted_at)/.test(text)) throw new Error('simulated failure');
    return realQuery(text, values);
  };
  try {
    await assert.rejects(updatePolicy(client, { tenantRef, policyId: failing.id, name: 'Mine', maxBlastRadius: 'cosmetic', actor: 'admin' }), /simulated failure/);
    await assert.rejects(deletePolicy(client, { tenantRef, policyId: failing.id, deletedBy: 'admin' }), /simulated failure/);
  } finally {
    client.query = realQuery;
  }
  assert.equal((await changes()).length, recordsBefore, 'a failed edit or delete leaves no record');
  assert.equal((await getPolicy(client, { tenantRef, id: failing.id })).name, 'Fails', 'and changes nothing');
  const { rows: [head] } = await client.query('SELECT record_count::int AS n FROM evidence_head WHERE tenant_ref = $1', [tenantRef]);
  const { rows: [all] } = await client.query('SELECT count(*)::int AS n FROM evidence WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(head.n, all.n, 'the audit record chain head still matches its records');

  // Delete: off, marked, kept; skipped by every reader and by evaluation.
  const drift = { id: randomUUID(), natural_key: 'group:x', resource_type: 'group', change_type: 'modified', blast_radius: 'cosmetic' };
  const other = await createPolicy(client, { tenantRef, name: 'Alert on anything', action: 'alert', maxBlastRadius: 'cosmetic', createdBy: 'admin' });
  assert.ok((await evaluateDrift(client, { tenantRef, drift })).matches.some((match) => match.policyId === other.id));
  const deleted = await deletePolicy(client, { tenantRef, policyId: other.id, deletedBy: 'admin-2' });
  assert.equal(deleted.enabled, false);
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by, 'admin-2');
  const deleteRecord = (await changes()).at(-1);
  assert.equal(deleteRecord.actor, 'admin-2');
  assert.equal(deleteRecord.subject.change, 'deleted');
  assert.equal(deleteRecord.subject.name, 'Alert on anything');
  assert.deepEqual(deleteRecord.subject.fields.slice(0, 3), [
    { field: 'action', before: 'alert', after: null },
    { field: 'enabled', before: true, after: false },
    { field: 'name', before: 'Alert on anything', after: null },
  ], 'the record keeps the rule as it was');
  assert.equal(await getPolicy(client, { tenantRef, id: other.id }), null, 'a deleted rule reads as not found');
  assert.ok(!(await listPolicies(client, { tenantRef })).some((policy) => policy.id === other.id), 'a deleted rule is not listed');
  assert.ok(!(await listPolicies(client, { tenantRef, enabled: false })).some((policy) => policy.id === other.id));
  assert.ok(!(await evaluateDrift(client, { tenantRef, drift: { ...drift, id: randomUUID() } })).matches.some((match) => match.policyId === other.id), 'a deleted rule never matches');
  await assert.rejects(setPolicyEnabled(client, { policyId: other.id, enabled: true }), /not found/, 'a deleted rule cannot be turned back on');
  await assert.rejects(clearPolicyPause(client, { policyId: other.id }), /not found/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: other.id, name: 'x', maxBlastRadius: 'cosmetic', actor: 'admin' }), /not found/, 'a deleted rule cannot be edited');
  await assert.rejects(deletePolicy(client, { tenantRef, policyId: other.id, deletedBy: 'admin' }), /not found/, 'deleting twice reads as not found');
  await assert.rejects(deletePolicy(client, { tenantRef: 'sha256:other', policyId: alert.id, deletedBy: 'admin' }), /not found/, 'another tenant cannot delete it');
  // A deleted undo rule never acts, even if something later left it marked on.
  await deletePolicy(client, { tenantRef, policyId: undo.id, deletedBy: 'admin' });
  const { rows: [forcedOn] } = await client.query('UPDATE policy SET enabled = true WHERE id = $1 RETURNING *', [undo.id]);
  await assert.rejects(assertExecutableAutomationPolicy(client, forcedOn), /is deleted/);
  const { rows } = await client.query('SELECT id FROM policy WHERE id = $1', [other.id]);
  assert.equal(rows.length, 1, 'the row is kept so its history still resolves');
  const { rows: evaluations } = await client.query("SELECT count(*)::int AS n FROM evidence WHERE kind = 'policy-evaluation' AND tenant_ref = $1", [tenantRef]);
  assert.equal(evaluations[0].n, 2, 'both evaluations stay as evidence');
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('editDelete.test.mjs — all assertions passed');
