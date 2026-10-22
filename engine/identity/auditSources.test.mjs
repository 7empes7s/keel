/**
 * Who made a change: reading the Entra and Intune audit logs with the Collector
 * (auditSources.mjs) into task 91's minimized facts, and matching them to changes by the
 * object id the change carries. Graph is a fake reader; nothing reaches a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { attributeChanges } from './attribution.mjs';
import {
  auditSourceFor, changeObjectIds, createGraphAuditAdapter, directoryAuditEvents, ingestCollectorAudit, intuneAuditEvents,
} from './auditSources.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const TENANT = 'tenant-audit-sources';
const GROUP = '11111111-1111-4111-8111-111111111111';
const POLICY = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ALICE = 'aaaaaaaa-0000-4000-8000-00000000a11c';
const SYNC_SP = 'bbbbbbbb-0000-4000-8000-000000000b0b';
const SYNC_APP = 'cccccccc-0000-4000-8000-000000000c0c';
const NOW = new Date('2026-10-22T12:00:00Z');
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600000).toISOString();

const directoryAudit = (id, hoursAgo, extra = {}) => ({
  id, activityDateTime: at(hoursAgo), activityDisplayName: 'Add member to group', operationType: 'Assign', result: 'success',
  initiatedBy: { user: { id: ALICE, userPrincipalName: 'alice@contoso.example', ipAddress: '203.0.113.7' } },
  targetResources: [
    { id: GROUP, type: 'Group', displayName: 'Helpdesk', modifiedProperties: [{ displayName: 'Group.DisplayName', newValue: '"canary"' }] },
    { id: USER, type: 'User', userPrincipalName: 'bob@contoso.example' },
  ],
  ...extra,
});
const intuneAudit = (id, hoursAgo, extra = {}) => ({
  id, activityDateTime: at(hoursAgo), activity: 'Patch DeviceConfiguration', activityOperationType: 'Patch', activityResult: 'Success',
  actor: { applicationId: SYNC_APP, applicationDisplayName: 'Contoso Sync', userPrincipalName: null },
  resources: [{ resourceId: POLICY, type: 'DeviceConfiguration', displayName: 'Windows baseline' }],
  ...extra,
});

test('audit records become minimized facts, one per object they name', async () => {
  const events = directoryAuditEvents(directoryAudit('Directory_1', 2));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => [event.change.targetType, event.change.targetId, event.change.operation]),
    [['group', GROUP, 'update'], ['user', USER, 'update']]);
  assert.deepEqual(events[0].change, {
    operation: 'update', activity: 'Add member to group', fields: [], actorKind: 'user', actorId: ALICE, targetType: 'group', targetId: GROUP,
  });
  const stored = JSON.stringify(events);
  for (const leaked of ['alice@contoso', 'bob@contoso', '203.0.113', 'canary', 'Helpdesk']) assert.ok(!stored.includes(leaked), leaked);

  // A failed attempt changed nothing; an unknown operation is not guessed; neither yields a fact.
  assert.equal(directoryAuditEvents(directoryAudit('Directory_2', 2, { result: 'failure' }))[0].change, undefined);
  assert.equal(directoryAuditEvents(directoryAudit('Directory_3', 2, { operationType: 'Other' }))[0].change, undefined);
  // An app actor is its service principal; an object without an object id is skipped.
  const byApp = directoryAuditEvents(directoryAudit('Directory_4', 2, {
    initiatedBy: { app: { servicePrincipalId: SYNC_SP, displayName: 'Contoso Sync' } },
    targetResources: [{ id: 'not-a-guid', type: 'Policy' }, { id: POLICY.toUpperCase(), type: 'Policy' }],
  }));
  assert.deepEqual(byApp.map((event) => [event.change.actorKind, event.change.actorId, event.change.targetId]), [['servicePrincipal', SYNC_SP, POLICY]]);

  // Intune names an app by its app id: KEEL turns it into the service principal's object id.
  const asked = [];
  const [intune] = await intuneAuditEvents(intuneAudit('ia-1', 1), async (appId) => { asked.push(appId); return SYNC_SP; });
  assert.deepEqual(asked, [SYNC_APP]);
  assert.deepEqual([intune.id, intune.change.operation, intune.change.actorKind, intune.change.actorId, intune.change.targetType],
    ['intune:ia-1:0', 'update', 'servicePrincipal', SYNC_SP, 'deviceConfiguration']);
  const [byUser] = await intuneAuditEvents(intuneAudit('ia-2', 1, { actor: { userId: ALICE }, activityOperationType: 'Delete' }));
  assert.deepEqual([byUser.change.operation, byUser.change.actorId], ['delete', ALICE]);
  const [unknownApp] = await intuneAuditEvents(intuneAudit('ia-3', 1));
  assert.equal(unknownApp.change, undefined, 'an app KEEL cannot resolve is not named');
});

test('each change knows its audit log and the object ids a record would name', () => {
  assert.deepEqual(auditSourceFor('group'), { source: 'audit', service: 'Entra' });
  assert.deepEqual(auditSourceFor('conditionalAccessPolicy'), { source: 'audit', service: 'Entra' });
  assert.deepEqual(auditSourceFor('groupMembership'), { source: 'audit', service: 'Entra' });
  assert.deepEqual(auditSourceFor('deviceConfiguration'), { source: 'intune-audit', service: 'Intune' });
  assert.deepEqual(auditSourceFor('policyAssignment'), { source: 'intune-audit', service: 'Intune' });
  assert.deepEqual(auditSourceFor('sharepointSettings'), { source: null, service: 'SharePoint' });
  assert.deepEqual(auditSourceFor('someUnknownType'), { source: null, service: null });

  assert.deepEqual(changeObjectIds({ naturalKey: 'group:Helpdesk', before: { id: GROUP.toUpperCase() }, after: { id: GROUP } }), [GROUP]);
  assert.deepEqual(changeObjectIds({ naturalKey: `edge:member:${GROUP}:${USER}`, before: null, after: null }), [GROUP, USER]);
  assert.deepEqual(changeObjectIds({ naturalKey: 'sharepointSettings:tenant', before: { id: 'tenant' }, after: null }), []);
});

function fakeReader(pages) {
  const calls = [];
  return {
    calls,
    async collect(version, path) {
      calls.push(path);
      const source = path.startsWith('/auditLogs') ? 'audit' : 'intune-audit';
      const page = pages[source];
      if (page.status) return { items: [], pages: 0, capped: false, error: { ok: false, status: page.status } };
      const filter = decodeURIComponent(path.split('$filter=')[1]);
      const [, from, until] = /ge (\S+) and activityDateTime le (\S+)/.exec(filter);
      const items = page.items.filter((item) => item.activityDateTime >= from && item.activityDateTime <= until);
      return { items, pages: 1, capped: Boolean(page.capped), error: null };
    },
    async get(version, path) {
      calls.push(path);
      return path.includes(SYNC_APP) ? { ok: true, status: 200, body: { id: SYNC_SP } } : { ok: false, status: 404 };
    },
  };
}

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(schemaSql());
  const { rows: [collector] } = await client.query("INSERT INTO principal(email) VALUES ('collector@example.invalid') RETURNING id");
  await grantRole(client, { principalId: collector.id, role: 'operator', grantedBy: 'fixture', activeFrom: '2020-01-01Z' });
  return { client, collector: collector.id };
}

const change = (id, resourceType, naturalKey, objectIds, hoursFrom, hoursUntil, changeType = 'modified') => ({
  id, resourceType, naturalKey, changeType, fields: [], objectIds, window: { from: at(hoursFrom), until: at(hoursUntil) },
});

test('each backup reads both logs forward a day at a time, and changes are matched by object id', async (t) => {
  const { client, collector } = await setup(t);
  const reader = fakeReader({
    audit: { items: [directoryAudit('Directory_member', 30), directoryAudit('Directory_old', 24 * 40)] },
    'intune-audit': { items: [intuneAudit('ia-patch', 5)] },
  });
  const lines = [];
  const first = await ingestCollectorAudit(client, { tenantRef: TENANT, reader, requestedBy: collector, now: NOW, log: (line) => lines.push(line) });
  assert.deepEqual(Object.values(first.sources).map((source) => source.status), ['complete-empty', 'complete'], 'the status of the last day read');
  // 30 days back, one day per read, up to a quarter of an hour ago.
  assert.equal(first.sources.audit.windows, 30);
  assert.equal(first.sources.audit.insertedEvents, 2, 'the membership change names the group and the user');
  assert.equal(first.sources['intune-audit'].insertedEvents, 1);
  assert.ok(reader.calls.every((path) => path.startsWith('/auditLogs/directoryAudits?$filter=') || path.startsWith('/deviceManagement/auditEvents?$filter=') || path.startsWith('/servicePrincipals(')));
  assert.match(lines[0], /^Microsoft Entra audit log: complete-empty \(30 day\(s\) read, 2 new record\(s\)\)$/);
  const { rows: facts } = await client.query('SELECT source_event_id, target_id, actor_kind, actor_id FROM audit_change_fact ORDER BY source_event_id');
  assert.deepEqual(facts.map((fact) => fact.source_event_id), ['entra:Directory_member:0', 'entra:Directory_member:1', 'intune:ia-patch:0']);

  // The next backup an hour later reads only the new hour.
  reader.calls.length = 0;
  const next = await ingestCollectorAudit(client, { tenantRef: TENANT, reader, requestedBy: collector, now: new Date(NOW.getTime() + 3600000) });
  assert.equal(next.sources.audit.windows, 1);
  assert.equal(reader.calls.filter((path) => path.startsWith('/auditLogs')).length, 1);

  const results = await attributeChanges(client, {
    tenantRef: TENANT,
    changes: [
      // A member was added to the group: recorded on the group (no lineage needed).
      change('member', 'groupMembership', `edge:member:${GROUP}:${USER}`, changeObjectIds({ naturalKey: `edge:member:${GROUP}:${USER}` }), 48, 24),
      change('policy', 'deviceConfiguration', 'deviceConfiguration:Windows baseline', [POLICY], 10, 2),
      change('quiet', 'group', 'group:Other', ['44444444-4444-4444-8444-444444444444'], 10, 2),
      change('sharepoint', 'sharepointSettings', 'sharepointSettings:tenant', [], 10, 2),
      change('nameless', 'group', 'group:Nameless', [], 10, 2),
    ],
  });
  const by = Object.fromEntries(results.map((entry) => [entry.changeId, entry]));
  assert.deepEqual([by.member.verdict, by.member.source, by.member.actors], ['exact', 'audit', [{ kind: 'user', id: ALICE, name: null }]]);
  assert.equal(by.member.evidence[0].activity, 'Add member to group');
  assert.deepEqual([by.policy.verdict, by.policy.source, by.policy.actors[0].id], ['exact', 'intune-audit', SYNC_SP]);
  assert.deepEqual([by.quiet.verdict, by.quiet.reason], ['unknown', 'no-audit-record-names-resource'], 'a complete log with no record says so');
  assert.deepEqual([by.sharepoint.verdict, by.sharepoint.reason, by.sharepoint.source, by.sharepoint.service], ['unknown', 'audit-source-not-read', null, 'SharePoint']);
  assert.deepEqual([by.nameless.verdict, by.nameless.reason], ['unknown', 'resource-identity-unresolved']);
});

test('a refused or oversized read is recorded, never taken as an empty log', async (t) => {
  const { client, collector } = await setup(t);
  const reader = fakeReader({ audit: { items: [], capped: true }, 'intune-audit': { status: 403 } });
  const result = await ingestCollectorAudit(client, { tenantRef: TENANT, reader, requestedBy: collector, now: NOW });
  assert.equal(result.sources.audit.status, 'read-failed');
  assert.equal(result.sources['intune-audit'].status, 'read-scope-revoked');
  const [policy, group] = await attributeChanges(client, {
    tenantRef: TENANT,
    changes: [change('policy', 'deviceConfiguration', 'deviceConfiguration:Windows baseline', [POLICY], 10, 2), change('group', 'group', 'group:Helpdesk', [GROUP], 10, 2)],
  });
  assert.deepEqual([policy.verdict, policy.reason], ['unknown', 'audit-read-scope-revoked']);
  assert.deepEqual([group.verdict, group.reason], ['unknown', 'audit-read-failed']);

  // The adapter itself keeps a stable, sorted window and pages through it by offset.
  const adapter = createGraphAuditAdapter({
    tenantRef: TENANT,
    reader: fakeReader({ audit: { items: [directoryAudit('b', 1), directoryAudit('a', 2)] }, 'intune-audit': { items: [] } }),
  });
  const page1 = await adapter.readPage({ source: 'audit', from: at(3), until: at(0), cursor: null, limit: 3 });
  assert.deepEqual(page1.events.map((event) => event.id), ['entra:a:0', 'entra:a:1', 'entra:b:0']);
  assert.equal(page1.nextCursor, 3);
  const page2 = await adapter.readPage({ source: 'audit', from: at(3), until: at(0), cursor: 3, limit: 3 });
  assert.deepEqual([page2.events.map((event) => event.id), page2.nextCursor], [['entra:b:1'], null]);
});
