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
    maxActionsPerWindow: null, windowSeconds: null,
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
  const relimited = await updatePolicy(client, { tenantRef, policyId: alert.id, name: 'Alert on FIN users', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 50, windowSeconds: 3600 });
  assert.equal(relimited.max_actions_per_window, 50);
  assert.equal(relimited.resource_type, null, 'a field left out of an edit is cleared, not kept');

  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: ' ', maxBlastRadius: 'cosmetic' }), /name is required/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: 'x', maxBlastRadius: 'huge' }), /invalid max blast radius/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: alert.id, name: 'x', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 5 }), /both a count and a window/);
  await assert.rejects(updatePolicy(client, { tenantRef: 'sha256:other', policyId: alert.id, name: 'x', maxBlastRadius: 'cosmetic' }), /not found/, 'another tenant cannot edit it');

  // Editing an undo rule that is on turns it off: its activation preview was for the old scope.
  const undo = await createPolicy(client, {
    tenantRef, name: 'Undo low risk', action: 'auto_remediate', maxBlastRadius: 'cosmetic', enabled: true,
    createdBy: 'admin', runAsPrincipalId: runAs.id,
  });
  assert.equal(undo.enabled, true);
  const undoEdited = await updatePolicy(client, { tenantRef, policyId: undo.id, name: 'Undo low risk groups', resourceType: 'group', maxBlastRadius: 'cosmetic', maxActionsPerWindow: 10, windowSeconds: 3600 });
  assert.equal(undoEdited.enabled, false, 'an edited undo rule is off until previewed again');
  assert.equal(String(undoEdited.run_as_principal_id), String(runAs.id), 'the account it acts as is kept');

  // Delete: off, marked, kept; skipped by every reader and by evaluation.
  const drift = { id: randomUUID(), natural_key: 'group:x', resource_type: 'group', change_type: 'modified', blast_radius: 'cosmetic' };
  const other = await createPolicy(client, { tenantRef, name: 'Alert on anything', action: 'alert', maxBlastRadius: 'cosmetic', createdBy: 'admin' });
  assert.ok((await evaluateDrift(client, { tenantRef, drift })).matches.some((match) => match.policyId === other.id));
  const deleted = await deletePolicy(client, { tenantRef, policyId: other.id, deletedBy: 'admin-2' });
  assert.equal(deleted.enabled, false);
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by, 'admin-2');
  assert.equal(await getPolicy(client, { tenantRef, id: other.id }), null, 'a deleted rule reads as not found');
  assert.ok(!(await listPolicies(client, { tenantRef })).some((policy) => policy.id === other.id), 'a deleted rule is not listed');
  assert.ok(!(await listPolicies(client, { tenantRef, enabled: false })).some((policy) => policy.id === other.id));
  assert.ok(!(await evaluateDrift(client, { tenantRef, drift: { ...drift, id: randomUUID() } })).matches.some((match) => match.policyId === other.id), 'a deleted rule never matches');
  await assert.rejects(setPolicyEnabled(client, { policyId: other.id, enabled: true }), /not found/, 'a deleted rule cannot be turned back on');
  await assert.rejects(clearPolicyPause(client, { policyId: other.id }), /not found/);
  await assert.rejects(updatePolicy(client, { tenantRef, policyId: other.id, name: 'x', maxBlastRadius: 'cosmetic' }), /not found/, 'a deleted rule cannot be edited');
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
