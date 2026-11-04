import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from './dbTestHelper.mjs';
import { grantRole } from '../authz/administration.mjs';

export async function flagFixture(testFile) {
  const database = await createIsolatedTestDatabase(testFile);
  const client = await database.connect();
  await client.query(schemaSql());
  const tenantRef = 'flag-test';
  const at = new Date(Date.now() - 3600_000);
  const policyId = 'ca000000-0000-4000-8000-000000000001';
  const actorId = 'ab000000-0000-4000-8000-000000000001';
  const naturalKey = `conditionalAccessPolicy:${policyId}`;
  const policy = (state) => ({ id: policyId, displayName: 'Require MFA for admins', state });
  const { rows: [principal] } = await client.query("INSERT INTO principal (email, display_name) VALUES ('reviewer@test.example','Reviewer') RETURNING id");
  await grantRole(client, { principalId: principal.id, role: 'admin', grantedBy: principal.id, activeFrom: new Date(Date.now() - 86400_000) });
  await grantRole(client, { principalId: principal.id, role: 'operator', grantedBy: principal.id, activeFrom: new Date(Date.now() - 86400_000) });
  await grantRole(client, { principalId: principal.id, role: 'viewer', grantedBy: principal.id, activeFrom: new Date(Date.now() - 86400_000) });
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref,set_by) VALUES ($1,'test') RETURNING id", [tenantRef]);
  async function snapshot(state, when = at) {
    const { rows: [snap] } = await client.query("INSERT INTO snapshot (tenant_ref,started_at,completed_at,status) VALUES ($1,$2,$2,'complete') RETURNING id", [tenantRef, when]);
    for (const [key, type, payload] of [[naturalKey, 'conditionalAccessPolicy', policy(state)], ['user:ada@test.example', 'user', { id: actorId, displayName: 'Ada Admin' }]]) {
      await client.query(`INSERT INTO resource_version (snapshot_id,natural_key,resource_type,payload,payload_hash,criticality,blast_radius,fidelity,provenance)
        VALUES ($1,$2,$3,$4,'hash','tier2','access-affecting','full','{}')`, [snap.id, key, type, payload]);
    }
    return snap.id;
  }
  const snapshotId = await snapshot('disabled');
  const { rows: [drift] } = await client.query(`INSERT INTO drift (tenant_ref,baseline_id,observed_snapshot,natural_key,resource_type,change_type,before_hash,after_hash,before_payload,after_payload,blast_radius,detected_at)
    VALUES ($1,$2,$3,$4,'conditionalAccessPolicy','modified','before','after',$5,$6,'access-affecting',$7) RETURNING id`, [tenantRef, baseline.id, snapshotId, naturalKey, policy('enabled'), policy('disabled'), at]);
  async function audit(id = 'entra:flag:0', activity = 'Delete conditional access policy', target = policyId) {
    await client.query(`INSERT INTO audit_change_fact (tenant_ref,source_event_id,occurred_at,target_type,target_id,operation,activity,actor_kind,actor_id)
      VALUES ($1,$2,$3,'Policy',$4,'delete',$5,'user',$6)`, [tenantRef, id, new Date(at.getTime() - 1000), target, activity, actorId]);
    return id;
  }
  return { database, client, tenantRef, at, naturalKey, policyId, actorId, actor: principal.id, driftId: drift.id, snapshotId, snapshot, audit,
    async close() { await client.end(); await database.cleanup(); } };
}
