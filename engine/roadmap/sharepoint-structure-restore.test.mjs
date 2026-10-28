// SharePoint structure restore through PnP: a named site's missing lists, libraries,
// columns and content types and its navigation; site scripts, site designs and hub sites.
//
// Acceptance:
//  - the seven writes are declared, each with its own proof, and ship disabled; the Node
//    and container allowlists match; no cmdlet deletes, unregisters, grants or revokes;
//  - the template KEEL applies holds only what is missing and the navigation, never list
//    items, permissions, webhooks, custom actions, property bags, features or settings;
//    the container checks its elements again and fixes the handlers;
//  - a fixture restore puts back a deleted library, column, content type, navigation,
//    script, design and hub settings, verifies each by read-back, and a design waiting
//    for a re-added script is put back on the next run, pointed at its new id; a third
//    run writes nothing;
//  - nothing newer is deleted and nothing existing is changed: differences are listed;
//  - on the test tenant only KEEL-RT- sites, scripts, designs and hubs are written; a
//    default design or the root site needs the tenant-wide option;
//  - a script that would send site data to a flow needs the separate approval;
//  - a target changed since the dry run is stale; an unknown outcome is never resent.
//
// Everything runs against the isolated test database and a fake PnP container behind the
// real engine/powershell/jobQueue.mjs spawn path, which enforces the allowlists parsed
// from ops/powershell/run-cmdlet.ps1. No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { readSharePointStructure, recordSharePointStructureRun } from '../collect/workloads/sharepointStructure.mjs';
import { WORKLOAD_WRITE_OPERATIONS, workloadWriteQualification } from '../coverage/qualification.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { loadWorkloadSource } from '../restore/workloads/cmdletSettings.mjs';
import {
  MAX_TEMPLATE_GZIP_CHARS, SHAREPOINT_STRUCTURE_WRITE_OPS, STRIPPED_ELEMENTS, SharePointStructureWriteScopeError, TEMPLATE_ELEMENTS,
  buildRestoreTemplate, createSharePointStructureRestoreArtifact, executeSharePointStructureRestore, planSharePointStructureRestore,
  siteScriptEffects, structureReader, structureWriteCmdlet, unsupportedElements,
} from '../restore/workloads/sharepointStructure.mjs';
import { SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS, SHAREPOINT_STRUCTURE_WRITE_OPERATIONS } from '../restore/workloads/sharepointStructureWrites.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { HOST, NS, SITE, WRITES, fakeTenant, initialState, newGuid, templateXml } from '../test/fakePnpStructure.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-27T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-0000000000e1';
let tenantSeq = 0;
const nextTenant = () => `sha256:sp-structure-restore-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role = null) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${label}-${principalSeq += 1}@example.test`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}
const SCRIPT = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');

const read = structureReader();
const readAll = (live) => read({ powershell: live.powershell, sites: [SITE] });

async function recordSource(client, tenantRef, live) {
  const result = await readSharePointStructure({ powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => NOW });
  assert.equal(result.outcome, 'complete', JSON.stringify(result.failures));
  const run = await recordSharePointStructureRun(client, { tenantRef, result });
  return loadWorkloadSource(client, { tenantRef, collectionId: run.id, workload: 'sharepoint-structure' });
}

async function planned(client, tenantRef, live, source, options = {}) {
  const plan = planSharePointStructureRestore({ source, live: await readAll(live), tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef], ...options });
  const requestedBy = await principal(client, 'requester');
  const artifact = await createSharePointStructureRestoreArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact };
}

const enabled = () => Object.fromEntries(SHAREPOINT_STRUCTURE_WRITE_OPS.map((id) => [id, { operationId: id, state: 'live-qualified', enabled: true, reasons: [] }]));
const execute = (client, tenantRef, artifact, live, qualifications = enabled()) => executeSharePointStructureRestore(client, {
  tenantRef, artifactId: artifact.id, tenantId: TENANT, read, powershell: live.powershell, qualifications, testTenantRefs: [tenantRef],
});
const opsOf = (plan) => plan.operations.map((op) => `${op.operationId}:${op.key.split(':')[0]}`);

// ------------------------------------------------------------ declarations and allowlists

test('the seven writes are declared, each with its own proof, and ship disabled', () => {
  assert.deepEqual([...SHAREPOINT_STRUCTURE_WRITE_OPS].sort(), Object.keys(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS).sort());
  for (const id of SHAREPOINT_STRUCTURE_WRITE_OPS) {
    const write = WORKLOAD_WRITE_OPERATIONS[id];
    assert.ok(write, `${id} is in the qualification table`);
    assert.equal(write.workload, 'sharepoint-structure');
    assert.ok(WORKLOAD_DESCRIPTORS.some((descriptor) => descriptor.id === write.readBack), `${id} reads back with a declared read`);
    assert.ok(SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS[write.method], `${id} runs an allowlisted cmdlet`);
    for (const field of write.fields) if (field !== 'SiteUrl' && write.family !== 'siteTemplate') assert.ok(SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS[write.method].includes(field), `${id}: ${field}`);
    const off = workloadWriteQualification(id, { tenantRef: 'sha256:t', now: NOW });
    assert.equal(off.enabled, false, `${id} is off without a live capture`);
    const fixtureOnly = workloadWriteQualification(id, { tenantRef: 'sha256:t', now: NOW, evidence: [{ operationId: id, kind: 'fixture', ok: true, synthetic: true }] });
    assert.equal(fixtureOnly.state, 'fixture-tested');
    assert.equal(fixtureOnly.enabled, false, `${id}: a fixture pass never switches it on`);
  }
});

test('the Node and container allowlists match; nothing deletes; the template is checked again in the container', () => {
  assert.deepEqual(WRITES, Object.fromEntries(Object.entries(SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])));
  for (const cmdlet of Object.keys(WRITES)) assert.match(cmdlet, /^(Add|Set|Register|Invoke)-PnP/, `${cmdlet} never deletes, unregisters, grants or revokes`);
  const elements = /\$RestoreTemplateElements = @\(([\s\S]*?)\n\)/.exec(SCRIPT)[1];
  assert.deepEqual([...elements.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]), [...TEMPLATE_ELEMENTS]);
  for (const name of STRIPPED_ELEMENTS) assert.ok(!TEMPLATE_ELEMENTS.includes(name), `${name} is never sent`);
  for (const name of ['Features', 'WebSettings', 'RegionalSettings', 'Files', 'Pages', 'ClientSidePages', 'SiteSecurity', 'TermGroups', 'CustomActions', 'ComposedLook']) {
    assert.ok(!TEMPLATE_ELEMENTS.includes(name), `${name} is never sent`);
  }
  assert.equal(/\$RestoreTemplateHandlers = '([^']+)'/.exec(SCRIPT)[1], 'Fields, ContentTypes, Lists, Navigation');
  assert.match(SCRIPT, /\$params = @\{ Path = \$templateFile; Handlers = \$RestoreTemplateHandlers \}/, 'the handlers are the container\'s, never the job\'s');
  assert.match(SCRIPT, /if \(\$name -eq 'Invoke-PnPSiteTemplate'\) \{\s+\$pnpUrl = Get-KeelSiteUrl/, 'the template is applied on a site collection root of the tenant host');
  assert.match(SCRIPT, /\$hubUrl = Get-KeelSiteUrl/, 'a hub is a site collection root of the tenant host');
  assert.match(SCRIPT, /\$MaxTemplateGzipChars = 100000/);
  assert.equal(MAX_TEMPLATE_GZIP_CHARS, 100000);
});

test('the write transport refuses an undeclared cmdlet, parameter, structured value or template element before sending', async () => {
  const live = fakeTenant();
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Remove-PnPSiteScript', parameters: { Identity: 'x' } }, live.powershell), SharePointStructureWriteScopeError);
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Set-PnPSiteScript', parameters: { Identity: 'x', Version: 2 } }, live.powershell), /does not take Version/);
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Set-PnPSiteScript', parameters: { Identity: 'x', Title: { a: 1 } } }, live.powershell), /only sends text/);
  const { gzipSync } = await import('node:zlib');
  const bad = gzipSync(Buffer.from(`<pnp:Provisioning xmlns:pnp="${NS}"><pnp:ProvisioningTemplate><pnp:Lists><pnp:ListInstance Url="x"><pnp:DataRows /></pnp:ListInstance></pnp:Lists></pnp:ProvisioningTemplate></pnp:Provisioning>`)).toString('base64');
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: SITE, TemplateGzip: bad } }, live.powershell), /DataRows/);
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: SITE, TemplateGzip: 'x'.repeat(MAX_TEMPLATE_GZIP_CHARS + 1) } }, live.powershell), /at most/);
  // A PnP element under another prefix, or a DTD, is refused too.
  const aliased = gzipSync(Buffer.from(`<pnp:Provisioning xmlns:pnp="${NS}"><pnp:ProvisioningTemplate><pnp:Lists><x:DataRows xmlns:x="${NS}" /></pnp:Lists></pnp:ProvisioningTemplate></pnp:Provisioning>`)).toString('base64');
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: SITE, TemplateGzip: aliased } }, live.powershell), /xmlns/);
  const dtd = gzipSync(Buffer.from(`<!DOCTYPE x [<!ENTITY e "y">]><pnp:Provisioning xmlns:pnp="${NS}"><pnp:ProvisioningTemplate /></pnp:Provisioning>`)).toString('base64');
  await assert.rejects(structureWriteCmdlet({ cmdlet: 'Invoke-PnPSiteTemplate', parameters: { Url: SITE, TemplateGzip: dtd } }, live.powershell), /DOCTYPE/);
  // Other namespaces (a taxonomy column's schema types) are left alone.
  assert.deepEqual(unsupportedElements(`<pnp:Provisioning xmlns:pnp="${NS}"><Field xmlns:q1="http://www.w3.org/2001/XMLSchema" /></pnp:Provisioning>`), []);
  assert.deepEqual(live.writes, [], 'nothing was sent');
});

// ------------------------------------------------------------ the template

test('the restore template holds only what is missing and the navigation, never content, permissions or code', () => {
  const site = initialState().sites[SITE.toLowerCase()];
  site.types.push({ ID: '0x0100BB', Name: 'KEEL-RT set', extra: '<pnp:DocumentSetTemplate><pnp:DefaultDocuments /></pnp:DocumentSetTemplate>' });
  const source = templateXml(site);
  const built = buildRestoreTemplate(source, {
    siteColumns: ['33333333-0000-4000-8000-000000000003'], contentTypes: ['0x0100aa', '0x0100bb'], lists: ['lists/keel-rt tasks', 'lists/gone'], navigation: true,
  });
  assert.deepEqual(unsupportedElements(built.xml), [], 'only allowed elements');
  assert.deepEqual(built.included, { siteColumns: ['33333333-0000-4000-8000-000000000003'], contentTypes: ['0x0100aa'], lists: ['lists/keel-rt tasks'], navigation: true });
  assert.deepEqual(built.skipped.map((item) => `${item.kind}:${item.key}`), ['contentTypes:0x0100bb', 'lists:lists/gone']);
  assert.match(built.skipped[0].reason, /DefaultDocuments, DocumentSetTemplate/);
  assert.deepEqual(built.removed, ['DataRows', 'Security', 'UserCustomActions', 'Webhooks']);
  for (const text of ['secret row', 'Everyone', 'example.test/hook', 'alert(1)', 'PropertyBag', 'WebSettings', 'RegionalSettings', 'Feature ', 'KeelRtProject" StaticName']) {
    assert.ok(!built.xml.includes(text), `${text} is not sent`);
  }
  assert.ok(built.xml.includes('Name="KeelRtOwner"') && built.xml.includes('<CHOICE>Open</CHOICE>'), 'the column and the list keep their own definition');
  assert.match(built.xml, /<pnp:StructuralNavigation\b[^>]*\sRemoveExistingNodes="true"/);
  assert.ok(!built.xml.includes('RemoveExistingNodes="false"'), 'the navigation replaces what is there');
  // The backed-up order is kept: navigation came first in this template.
  assert.ok(built.xml.indexOf('<pnp:Navigation') < built.xml.indexOf('<pnp:SiteFields>'));
  assert.ok(built.xml.indexOf('<pnp:SiteFields>') < built.xml.indexOf('<pnp:ContentTypes>'));
  assert.ok(built.xml.indexOf('<pnp:ContentTypes>') < built.xml.indexOf('<pnp:Lists>'));
  // Nothing asked for: an empty template, no navigation.
  const empty = buildRestoreTemplate(source, {});
  assert.ok(!/<pnp:(Lists|SiteFields|ContentTypes|Navigation)\b/.test(empty.xml));
  assert.throws(() => buildRestoreTemplate('<pnp:Provisioning xmlns:pnp="http://evil.example/x"><pnp:ProvisioningTemplate /></pnp:Provisioning>', { lists: ['x'] }), /PnP provisioning schema/);
});

test('a site script that would send site data out, share or add people is a content effect', () => {
  const quiet = '{"actions":[{"verb":"createSPList","listName":"x"}]}';
  const flow = '{"actions":[{"verb":"triggerFlow","url":"https://flow.example/a","name":"n"}]}';
  assert.deepEqual(siteScriptEffects({ naturalKey: 'k', before: null, after: quiet }), []);
  assert.deepEqual(siteScriptEffects({ naturalKey: 'k', before: quiet, after: flow }).map((effect) => `${effect.field}:${effect.effect}`), ['Content:triggerFlow:externally-sharing']);
  assert.deepEqual(siteScriptEffects({ naturalKey: 'k', before: flow, after: flow.replace(/\s/g, '') }), [], 'the same flow is no new effect');
  assert.equal(siteScriptEffects({ naturalKey: 'k', before: flow, after: flow.replace('flow.example/a', 'flow.example/b') }).length, 1, 'a flow pointed somewhere new counts');
  assert.equal(siteScriptEffects({ naturalKey: 'k', before: null, after: 'not json addPrincipalToSPGroup' }).length, 1, 'unreadable JSON is judged by its text');
});

// ------------------------------------------------------------ round trip

test('a deleted library, column, content type, navigation, script and hub settings come back, verified; a design follows on the next run', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  const site = live.state.sites[SITE.toLowerCase()];

  // Someone deletes a library, a site column, a content type and the script, changes the
  // navigation, the hub's title and the design's description, and adds a list of their own.
  const oldScriptId = live.state.scripts[0].Id;
  site.lists = site.lists.filter((list) => list.Title !== 'KEEL-RT tasks');
  site.lists.push({ Title: 'KEEL-RT newer', Url: 'Lists/KEEL-RT newer', TemplateType: 100 });
  site.columns = site.columns.filter((column) => column.Name !== 'KeelRtOwner');
  site.types = [];
  site.nav = ['Home', 'Somewhere else'];
  live.state.scripts = [];
  live.state.hubs[0].Title = 'KEEL-RT-renamed hub';
  live.state.designs[0].Description = 'changed';

  const first = await planned(client, tenantRef, live, source);
  assert.deepEqual(first.plan.refusals, []);
  assert.deepEqual(opsOf(first.plan), [
    'sharepoint-structure.site-script.add:site-script', 'sharepoint-structure.hub-site.update:hub-site', 'sharepoint-structure.site-template.update:site-template',
  ]);
  const manual = first.plan.manual.map((entry) => `${entry.resourceKey.split(':')[0]}|${entry.field}|${entry.reason}`).join('\n');
  assert.match(manual, /site-design\|SiteScriptIds\|one of its site scripts is not in the tenant yet/);
  assert.match(manual, /site-template\|lists\|lists newer than the backup; KEEL never deletes them/);
  assert.match(manual, /left out of what KEEL sends: DataRows, Security, UserCustomActions, Webhooks/);
  const siteOp = first.plan.operations.find((op) => op.family === 'siteTemplate');
  assert.deepEqual(siteOp.changes.map((change) => change.field), ['lists', 'siteColumns', 'contentTypes', 'navigation']);
  assert.deepEqual(siteOp.changes[0].after, ['Lists/KEEL-RT tasks']);
  assert.deepEqual(first.plan.contentEffects, []);
  assert.equal(first.artifact.status, 'completed');

  const result = await execute(client, tenantRef, first.artifact, live);
  assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
  assert.deepEqual(live.writes.map((write) => write.cmdlet), ['Add-PnPSiteScript', 'Set-PnPHubSite', 'Invoke-PnPSiteTemplate']);
  const sent = live.writes.find((write) => write.cmdlet === 'Invoke-PnPSiteTemplate');
  assert.deepEqual(Object.keys(sent.parameters).sort(), ['TemplateGzip', 'Url']);
  assert.deepEqual(unsupportedElements(sent.xml), []);
  assert.ok(!/secret row|Everyone|example\.test\/hook|PropertyBag|KEEL-RT newer|Shared Documents/.test(sent.xml), 'only what is missing, never content or permissions');
  assert.ok(site.lists.some((list) => list.Url === 'Lists/KEEL-RT tasks'));
  assert.ok(site.lists.some((list) => list.Url === 'Lists/KEEL-RT newer'), 'the newer list stays');
  assert.deepEqual(site.nav, ['Home', 'KEEL-RT tasks']);
  assert.equal(live.state.hubs[0].Title, 'KEEL-RT-hub');
  assert.equal(live.state.scripts.length, 1);
  const newScriptId = live.state.scripts[0].Id;
  assert.notEqual(newScriptId, oldScriptId);
  const { rows: evidence } = await client.query("SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'workload-restore' ORDER BY seq", [tenantRef]);
  assert.deepEqual(evidence.map((row) => row.subject.outcome), ['verified', 'verified', 'verified', 'verified']);

  // The next run puts the design back, pointed at the script's new id.
  const second = await planned(client, tenantRef, live, source);
  assert.deepEqual(opsOf(second.plan), ['sharepoint-structure.site-design.update:site-design']);
  // The design still names the deleted script's id; it is pointed at the re-added one.
  assert.deepEqual(second.plan.operations[0].parameters, { Identity: live.state.designs[0].Id, Description: 'd', SiteScriptIds: [newScriptId] });
  const done = await execute(client, tenantRef, second.artifact, live);
  assert.equal(done.outcome, 'verified', JSON.stringify(done.operations));
  assert.deepEqual(live.state.designs[0].SiteScriptIds, [newScriptId]);

  // Nothing left: the next dry run plans nothing and the promotion writes nothing.
  const last = await planned(client, tenantRef, live, source);
  assert.deepEqual(last.plan.operations, []);
  const before = live.writes.length;
  assert.equal((await execute(client, tenantRef, last.artifact, live)).outcome, 'no-change');
  assert.equal(live.writes.length, before);
});

test('a site that is no longer a hub is registered again, and its settings follow on the next run', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  live.state.hubs = [];
  const { plan, artifact } = await planned(client, tenantRef, live, source);
  assert.deepEqual(opsOf(plan), ['sharepoint-structure.hub-site.add:hub-site']);
  assert.deepEqual(plan.operations[0].parameters, { Site: SITE });
  assert.match(plan.manual.map((entry) => entry.reason).join('\n'), /run the restore again to put back its title/);
  assert.equal((await execute(client, tenantRef, artifact, live)).outcome, 'verified');
  const next = await planned(client, tenantRef, live, source);
  assert.deepEqual(opsOf(next.plan), ['sharepoint-structure.hub-site.update:hub-site']);
  assert.deepEqual(next.plan.operations[0].parameters, { Identity: SITE, Title: 'KEEL-RT-hub', Description: 'the hub' });
  assert.equal((await execute(client, tenantRef, next.artifact, live)).outcome, 'verified');
});

test('existing lists, columns and content types are never changed: each difference is listed with both values', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  live.state.sites[SITE.toLowerCase()].lists[0].EnableVersioning = 'false';
  live.state.sites[SITE.toLowerCase()].columns[0].Type = 'Note';
  const { plan } = await planned(client, tenantRef, live, source);
  assert.deepEqual(plan.operations, []);
  const versioning = plan.manual.find((entry) => entry.field === 'lists/Shared Documents/EnableVersioning');
  assert.deepEqual([versioning.before, versioning.after], ['false', 'true']);
  assert.match(versioning.reason, /never changes an existing one/);
  assert.ok(plan.manual.some((entry) => entry.field === 'siteColumns/KeelRtProject' && entry.before.Type === 'Note' && entry.after.Type === 'Text'));
});

test('nothing is written while the writes are not qualified', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  live.state.scripts = [];
  const { artifact } = await planned(client, tenantRef, live, source);
  const result = await execute(client, tenantRef, artifact, live, {});
  assert.equal(result.outcome, 'disabled');
  assert.deepEqual(live.writes, []);
});

test('on the test tenant only KEEL-RT- objects are written; a default design needs the tenant-wide option', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const state = initialState();
  state.designs.push({ ...state.designs[0], Id: newGuid(), Title: 'Marketing design', SiteScriptIds: [] });
  state.designs.push({ ...state.designs[0], Id: newGuid(), Title: 'KEEL-RT-default', IsDefault: true, SiteScriptIds: [] });
  const live = fakeTenant(state);
  const source = await recordSource(client, tenantRef, live);
  for (const design of live.state.designs) design.Description = 'changed';
  const { plan, artifact } = await planned(client, tenantRef, live, source);
  assert.equal(plan.refusals.length, 2);
  const reasons = plan.refusals.map((refusal) => refusal.reason).join('\n');
  assert.match(reasons, /\(Marketing design\) is not one/);
  assert.match(reasons, /is tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/);
  assert.deepEqual(opsOf(plan), ['sharepoint-structure.site-design.update:site-design']);
  assert.equal(artifact.status, 'refused', 'a refused object keeps the dry run from being promoted');
  const wide = planSharePointStructureRestore({ source, live: await readAll(live), tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef], allowTenantWide: true });
  assert.equal(wide.refusals.length, 1, 'the option lets the default design through, never a non-fixture');
  assert.equal(wide.operations.length, 2);
  // Off the test tenant nothing is limited to fixtures.
  const customer = planSharePointStructureRestore({ source, live: await readAll(live), tenantId: TENANT, tenantRef, testTenantRefs: [] });
  assert.deepEqual(customer.refusals, []);
  assert.equal(customer.operations.length, 3);
});

test('a site script that would send site data to a flow waits for a second person', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const state = initialState();
  state.scripts[0].Content = '{"actions":[{"verb":"triggerFlow","url":"https://flow.example/a","name":"KEEL-RT flow"}]}';
  const live = fakeTenant(state);
  const source = await recordSource(client, tenantRef, live);
  live.state.scripts = [];
  const { plan, artifact } = await planned(client, tenantRef, live, source);
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`), ['Content:triggerFlow:externally-sharing']);
  const blocked = await execute(client, tenantRef, artifact, live);
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.deepEqual(live.writes, []);
  const approver = await principal(client, 'approver', 'approver');
  await approveContentEffects(client, { tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'KEEL-RT- fixture restore' });
  assert.equal((await execute(client, tenantRef, artifact, live)).outcome, 'verified');
});

test('two backed-up objects with one title are never matched to each other; a design is added with its site type by name', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const state = initialState();
  const [a, b] = [newGuid(), newGuid()];
  state.scripts.push({ Id: a, Title: 'KEEL-RT-dup', Description: 'a', Content: '{"actions":[{"verb":"createSPList","listName":"A"}]}', Version: 1 });
  state.scripts.push({ Id: b, Title: 'KEEL-RT-dup', Description: 'b', Content: '{"actions":[{"verb":"createSPList","listName":"B"}]}', Version: 1 });
  const live = fakeTenant(state);
  const source = await recordSource(client, tenantRef, live);
  live.state.scripts = live.state.scripts.filter((script) => script.Id !== a);
  live.state.designs = [];
  const { plan, artifact } = await planned(client, tenantRef, live, source);
  assert.ok(!plan.operations.some((op) => op.parameters.Identity === b), 'B is never written with A');
  assert.ok(plan.manual.some((entry) => entry.resourceKey === `site-script:${a}` && /another object in the backup or the tenant has its title/.test(entry.reason)));
  const design = plan.operations.find((op) => op.operationId === 'sharepoint-structure.site-design.add');
  assert.equal(design.parameters.WebTemplate, 'TeamSite', 'Add-PnPSiteDesign takes the site type by name');
  assert.equal((await execute(client, tenantRef, artifact, live)).outcome, 'verified');
  assert.equal(live.state.scripts.find((script) => script.Id === b).Description, 'b');
});

test('a design that starts using a script which starts a flow waits for a second person', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const state = initialState();
  state.scripts[0].Content = '{"actions":[{"verb":"triggerFlow","url":"https://flow.example/a","name":"KEEL-RT flow"}]}';
  const live = fakeTenant(state);
  const source = await recordSource(client, tenantRef, live);
  live.state.designs[0].SiteScriptIds = [];
  const { plan } = await planned(client, tenantRef, live, source);
  assert.deepEqual(opsOf(plan), ['sharepoint-structure.site-design.update:site-design']);
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.resourceType}:${effect.effect}`), ['sharepointSiteDesign:externally-sharing']);
  assert.equal(plan.contentEffects[0].naturalKey, plan.operations[0].naturalKey);
});

test('a target changed since the dry run is stale; an unknown outcome is read back and never resent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  live.state.hubs[0].Title = 'KEEL-RT-renamed hub';
  const { artifact } = await planned(client, tenantRef, live, source);
  live.state.hubs[0].Description = 'changed again';
  const stale = await execute(client, tenantRef, artifact, live);
  assert.equal(stale.outcome, 'partial');
  assert.equal(stale.operations[0].outcome, 'stale');
  assert.deepEqual(live.writes, []);

  const crashing = fakeTenant(live.state, { crash: ['Set-PnPHubSite'] });
  const again = await planned(client, tenantRef, crashing, source);
  const result = await execute(client, tenantRef, again.artifact, crashing);
  assert.equal(result.operations[0].outcome, 'failed');
  assert.match(result.operations[0].reasons[0], /outcome was unknown .* it was not resent/);
  assert.equal(crashing.writes.length, 1, 'sent once');
});

test('the dispatch entry plans from a recorded collection and reads only the backed-up sites', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const source = await recordSource(client, tenantRef, live);
  const entry = WORKLOAD_RESTORES['sharepoint-structure'];
  assert.equal(entry.label, 'SharePoint site structure');
  assert.deepEqual([...entry.operations], [...SHAREPOINT_STRUCTURE_WRITE_OPS]);
  live.calls.length = 0;
  const plan = await entry.plan(client, { tenantRef, tenantId: TENANT, request: { collectionId: String(source.collectionId) }, connection: { powershell: live.powershell } });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(live.calls.filter((call) => call.cmdlet === 'Get-PnPSiteTemplate').map((call) => call.parameters.Url), [SITE]);
  await assert.rejects(entry.plan(client, { tenantRef, tenantId: TENANT, request: { collectionId: String(source.collectionId), tenantHost: 'fabrikam.sharepoint.com' }, connection: { powershell: live.powershell } }), /taken from contoso\.sharepoint\.com/);
  await assert.rejects(entry.plan(client, { tenantRef, tenantId: TENANT, request: {}, connection: { powershell: live.powershell } }), /--collection <id> is required/);
});
