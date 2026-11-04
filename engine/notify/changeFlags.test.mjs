import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagFixture } from '../test/changeFlagFixture.mjs';
import { acknowledgeAlert, applyConditionEvent, resolveAlert } from './alerts.mjs';
import { alertFlagDetails, flagSettings, resolveBackupFlags, resolveChangeFlags, setFlagEnabled, syncChangeFlags } from './changeFlags.mjs';
import { recordDisposition } from '../store/governance.mjs';

async function fixture(t) { const f = await flagFixture(import.meta.url); t.after(() => f.close()); return f; }
const driftOptions = (f) => ({ tenantRef: f.tenantRef, source: 'drift', ids: [f.driftId] });

test('flagged drift opens once, replay adds no transition, a later complete backup resolves it', async (t) => {
  const f = await fixture(t);
  const [opened] = await syncChangeFlags(f.client, driftOptions(f));
  assert.equal(opened.alert.control, 'change-flag');
  assert.equal(opened.alert.condition, 'ca-turned-off');
  assert.equal(opened.alert.severity, 'critical');
  assert.equal(opened.alert.last_observed_at.toISOString(), f.at.toISOString());
  await syncChangeFlags(f.client, driftOptions(f));
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert')).rows[0].n, 1);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert_transition')).rows[0].n, 1);
  await acknowledgeAlert(f.client, { tenantRef: f.tenantRef, alertId: opened.alert.id, actor: f.actor });
  assert.equal((await f.client.query('SELECT condition_active FROM alert')).rows[0].condition_active, true);
  const later = new Date(f.at.getTime() + 600_000);
  const snapshotId = await f.snapshot('enabled', later);
  await resolveBackupFlags(f.client, { tenantRef: f.tenantRef, snapshotId, observedAt: later, coveredTypes: [] });
  assert.equal((await f.client.query('SELECT condition_active FROM alert')).rows[0].condition_active, true);
  await resolveBackupFlags(f.client, { tenantRef: f.tenantRef, snapshotId, observedAt: later, coveredTypes: ['conditionalAccessPolicy'] });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
  await syncChangeFlags(f.client, driftOptions(f));
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
});

test('audit flags use natural keys, keep attribution private, and the audited review is a resolved observation', async (t) => {
  const f = await fixture(t);
  const id = await f.audit();
  const options = { tenantRef: f.tenantRef, source: 'audit', ids: [id] };
  const [opened] = await syncChangeFlags(f.client, options);
  assert.equal(opened.alert.resource_key, f.naturalKey);
  await syncChangeFlags(f.client, options);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert_transition')).rows[0].n, 1);
  const detail = (await alertFlagDetails(f.client, { tenantRef: f.tenantRef, alertIds: [opened.alert.id], namer: () => 'Person K7Q2' })).get(opened.alert.id)[0];
  assert.equal(detail.person.name, 'Person K7Q2');
  assert.match(detail.sentence, /Require MFA for admins/);
  await resolveAlert(f.client, { tenantRef: f.tenantRef, alertId: opened.alert.id, actor: f.actor, reason: 'Reviewed with the owner' });
  const { rows: [evidence] } = await f.client.query("SELECT * FROM evidence WHERE kind='alert-action' ORDER BY seq DESC LIMIT 1");
  assert.equal(evidence.actor, f.actor);
  assert.equal(evidence.subject.action, 'reviewed');
  assert.equal(evidence.subject.note, 'Reviewed with the owner');
  assert.equal((await f.client.query("SELECT outcome FROM alert_event_receipt WHERE event_id LIKE 'flag-reviewed:%'")).rows[0].outcome, 'resolved');
  await syncChangeFlags(f.client, options);
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
});

test('an open baseline is enriched, never duplicated, even when its source is replayed after closing', async (t) => {
  const f = await fixture(t);
  const baseline = await applyConditionEvent(f.client, { tenantRef: f.tenantRef, resourceKey: f.naturalKey, control: 'baseline', condition: 'drift', status: 'firing', eventId: 'baseline:test', occurredAt: f.at });
  const [result] = await syncChangeFlags(f.client, driftOptions(f));
  assert.equal(result.outcome, 'enriched');
  await syncChangeFlags(f.client, driftOptions(f));
  const { rows: alerts } = await f.client.query('SELECT * FROM alert');
  assert.equal(alerts.length, 1); // Revert check: removing enrichment opens a second row.
  assert.match(Object.values(alerts[0].detail.changeFlags)[0], /Turned off: Require MFA/);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert_transition')).rows[0].n, 1);
  await applyConditionEvent(f.client, { tenantRef: f.tenantRef, resourceKey: f.naturalKey, control: 'baseline', condition: 'drift', status: 'resolved', eventId: 'baseline:clear', occurredAt: new Date() });
  await syncChangeFlags(f.client, driftOptions(f));
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert')).rows[0].n, 1);
  assert.equal(baseline.alert.id, alerts[0].id);
});

test('acting on a change closes its flag; each rule is on by default and switching off is audited', async (t) => {
  const f = await fixture(t);
  assert.ok((await flagSettings(f.client, { tenantRef: f.tenantRef })).every((setting) => setting.enabled));
  await setFlagEnabled(f.client, { tenantRef: f.tenantRef, key: 'ca-turned-off', enabled: false, actor: f.actor });
  assert.deepEqual(await syncChangeFlags(f.client, driftOptions(f)), []);
  assert.equal((await f.client.query("SELECT subject->>'enabled' AS enabled FROM evidence WHERE kind='alert-action'")).rows[0].enabled, 'false');
  await setFlagEnabled(f.client, { tenantRef: f.tenantRef, key: 'ca-turned-off', enabled: true, actor: f.actor });
  await syncChangeFlags(f.client, driftOptions(f));
  await recordDisposition(f.client, { driftId: f.driftId, action: 'ignore', actor: f.actor, reason: 'Planned maintenance', expiresAt: new Date(Date.now() + 3600_000) });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
  await resolveChangeFlags(f.client, { tenantRef: f.tenantRef, sourceId: `drift:${f.driftId}` });
});

test('a flagged service change raises warning, replay is quiet, and a later read restores it', async (t) => {
  const f = await fixture(t);
  const read = async (fields, at) => {
    const { rows: [run] } = await f.client.query("INSERT INTO workload_collection (tenant_ref,workload,outcome,observed_from,observed_to) VALUES ($1,'sharepoint-tenant','complete',$2,$2) RETURNING id", [f.tenantRef, at]);
    await f.client.query("INSERT INTO workload_observation (collection_id,resource_key,fields) VALUES ($1,'tenant',$2)", [run.id, fields]);
    return run.id;
  };
  const before = await read({ SharingCapability: 'Disabled' }, new Date(f.at.getTime() - 60000));
  const current = await read({ SharingCapability: 'ExternalUserAndGuestSharing' }, f.at);
  const { rows: [change] } = await f.client.query(`INSERT INTO workload_drift (tenant_ref,workload,collection_id,previous_collection_id,resource_key,change_type,fields,blast_radius)
    VALUES ($1,'sharepoint-tenant',$2,$3,'tenant','modified',$4,'access-affecting') RETURNING id`, [f.tenantRef, current, before, JSON.stringify([{ path: 'SharingCapability', before: 'Disabled', after: 'ExternalUserAndGuestSharing' }])]);
  const options = { tenantRef: f.tenantRef, source: 'service', ids: [change.id] };
  const [opened] = await syncChangeFlags(f.client, options);
  assert.equal(opened.alert.severity, 'warning');
  await syncChangeFlags(f.client, options);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert_transition')).rows[0].n, 1);
  const later = new Date(f.at.getTime() + 60000);
  const restored = await read({ SharingCapability: 'Disabled' }, later);
  const { resolveServiceFlags } = await import('./changeFlags.mjs');
  await resolveServiceFlags(f.client, { tenantRef: f.tenantRef, collectionId: restored, workload: 'sharepoint-tenant', observedAt: later, complete: true });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
});

test('audit ingest persists flag work with the page and drains it through existing routing', async (t) => {
  const f = await fixture(t);
  const { ingestAudit, createFixtureAuditAdapter } = await import('../identity/auditIngest.mjs');
  const id = 'entra:ingest-flag:0';
  const options = { tenantRef: f.tenantRef, managedTenantRef: f.tenantRef, requestedBy: f.actor, source: 'audit', enabled: true,
    from: new Date(f.at.getTime() - 60000).toISOString(), until: new Date(f.at.getTime() + 60000).toISOString(),
    adapter: createFixtureAuditAdapter({ tenantRef: f.tenantRef, pages: [{ events: [{ id, occurredAt: f.at.toISOString(),
      change: { targetType: 'Policy', targetId: f.policyId, operation: 'delete', activity: 'Delete conditional access policy', actorKind: 'user', actorId: f.actorId } }], nextCursor: null }] }) };
  // Crash after cursor commit: the queued observation must survive and retry.
  await f.client.query(`CREATE FUNCTION reject_flag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
    CREATE TRIGGER reject_flag BEFORE INSERT ON change_flag_event FOR EACH ROW EXECUTE FUNCTION reject_flag()`);
  await assert.rejects(ingestAudit(f.client, options), /persistence failed/);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM change_flag_pending')).rows[0].n, 1);
  await f.client.query('DROP TRIGGER reject_flag ON change_flag_event');
  await ingestAudit(f.client, options);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM change_flag_pending')).rows[0].n, 0);
  assert.equal((await f.client.query('SELECT control FROM alert')).rows[0].control, 'change-flag');
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert_transition')).rows[0].n, 1);
});

test('baseline drift appearing after an audit flag folds the already-open alert', async (t) => {
  const f = await fixture(t);
  const id = await f.audit();
  await syncChangeFlags(f.client, { tenantRef: f.tenantRef, source: 'audit', ids: [id] });
  const { syncDriftAlerts } = await import('./alerts.mjs');
  await syncDriftAlerts(f.client, { tenantRef: f.tenantRef, snapshotId: f.snapshotId, observedAt: f.at,
    drift: [{ naturalKey: f.naturalKey, resourceType: 'conditionalAccessPolicy', changeType: 'modified', blastRadius: 'access-affecting' }], coveredTypes: ['conditionalAccessPolicy'] });
  const { rows: active } = await f.client.query('SELECT * FROM alert WHERE condition_active');
  assert.equal(active.length, 1);
  assert.equal(active[0].control, 'baseline');
  assert.match(Object.values(active[0].detail.changeFlags)[0], /Deleted: Require MFA/);
});

test('a backup without enterprise app credential fields cannot resolve an audited new secret', async (t) => {
  const f = await fixture(t);
  const appId = 'ab000000-0000-4000-8000-000000000002';
  const id = await f.audit('entra:secret:0', 'Add service principal credentials', appId);
  const [opened] = await syncChangeFlags(f.client, { tenantRef: f.tenantRef, source: 'audit', ids: [id] });
  const observe = async (credentials, offset) => {
    const when = new Date(f.at.getTime() + offset);
    const snapshotId = await f.snapshot('disabled', when);
    await f.client.query(`INSERT INTO resource_version (snapshot_id,natural_key,resource_type,payload,payload_hash,criticality,blast_radius,fidelity,provenance)
      VALUES ($1,'servicePrincipal:Payroll','servicePrincipal',$2,'app-hash','tier2','access-affecting','full','{}')`, [snapshotId, { id: appId, displayName: 'Payroll', ...credentials }]);
    await resolveBackupFlags(f.client, { tenantRef: f.tenantRef, snapshotId, observedAt: when, coveredTypes: ['servicePrincipal'] });
  };
  await observe({}, 60000);
  assert.equal((await f.client.query('SELECT state FROM alert WHERE id=$1', [opened.alert.id])).rows[0].state, 'open');
  await observe({ passwordCredentials: [], keyCredentials: [] }, 120000);
  assert.equal((await f.client.query('SELECT state FROM alert WHERE id=$1', [opened.alert.id])).rows[0].state, 'resolved');
});

test('a decision on an enriched change closes its baseline alert immediately', async (t) => {
  const f = await fixture(t);
  await applyConditionEvent(f.client, { tenantRef: f.tenantRef, resourceKey: f.naturalKey, control: 'baseline', condition: 'drift', status: 'firing', eventId: 'baseline:decision', occurredAt: f.at });
  await syncChangeFlags(f.client, driftOptions(f));
  await recordDisposition(f.client, { driftId: f.driftId, action: 'ignore', actor: f.actor, reason: 'Planned change', expiresAt: new Date(Date.now() + 3600_000) });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
  await syncChangeFlags(f.client, driftOptions(f));
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM alert')).rows[0].n, 1);
});

test('only an applied rollback resolves the flag; a dry-run or skipped resource leaves it open', async (t) => {
  const f = await fixture(t);
  await syncChangeFlags(f.client, driftOptions(f));
  const { resolveRolledBackFlags } = await import('./changeFlags.mjs');
  const resources = [{ naturalKey: f.naturalKey, resourceType: 'conditionalAccessPolicy', payload: { state: 'enabled' } }];
  await resolveRolledBackFlags(f.client, { tenantRef: f.tenantRef, resources, appliedKeys: [] });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'open');
  await resolveRolledBackFlags(f.client, { tenantRef: f.tenantRef, resources, appliedKeys: [f.naturalKey] });
  assert.equal((await f.client.query('SELECT state FROM alert')).rows[0].state, 'resolved');
});
