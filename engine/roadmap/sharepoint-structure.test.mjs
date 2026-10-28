// SharePoint structure through PnP: hub sites, site designs, site scripts and named sites'
// PnP templates, read-only.
//
// Acceptance:
//  - the reads are declared, pass the scope validator, are run by the read-only probe, and
//    ship disabled; the Node and container allowlists match; the read path runs no write;
//  - the container fixes the template handlers to structure only (no files, pages, term
//    store or property bag) and connects only to a site collection root on the tenant host;
//  - templates are read only for named site collection roots on the tenant host; anything
//    else is refused and nothing is sent for it; with no site named the read says so;
//  - each object is one observation with declared fields only; a site script's JSON comes
//    from a read by -Identity; a template keeps summaries plus the gzipped XML;
//  - each read turns on with its own proof; a list added to a site is a change on the
//    Changes page, and a template that only differs in PnP's own id or version is not;
//  - the read capture tool needs --site for templates and the admin site from the config;
//  - it sits in SharePoint's "Sites and OneDrive" group.
//
// Everything runs against the isolated test database and a fake PowerShell container that
// plays the ops/powershell/run-cmdlet.ps1 contract through the real jobQueue spawn path.
// No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { after, test } from 'node:test';

import {
  FAMILIES, MAX_TEMPLATE_BYTES, SHAREPOINT_STRUCTURE_CMDLET_PARAMETERS, SHAREPOINT_STRUCTURE_DESCRIPTOR, SHAREPOINT_STRUCTURE_OPERATIONS,
  SHAREPOINT_STRUCTURE_WORKLOAD, SharePointStructureScopeError, assertSharePointStructureCmdlet, collectSharePointStructure,
  readSharePointStructure, sharePointStructureActivation, structureSite, templateSummary,
} from '../collect/workloads/sharepointStructure.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { workloadGapReasons } from '../collect/workloads/gaps.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { typeInfo } from '../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { readOptionsFor } from '../../tools/qualification/workloadReadsLive.mjs';
import { ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith } from '../test/fakeCmdletContainer.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

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
let tenantSeq = 0;
const nextTenant = () => `sha256:sp-structure-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000b0b0`;
const HOST = 'contoso.sharepoint.com';
const SITE = `https://${HOST}/sites/KEEL-RT-structure`;
const ALLOWED = containerAllowlist('AllowedPnPStructure');
const SCRIPT = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');

// A PnP template as Get-PnPSiteTemplate writes it (trimmed), with a list per `lists` entry.
function template({ id = 'TEMPLATE-1', generator = 'PnP.Framework, 1.17.0', lists = ['Documents'], navigation = ['Home'] } = {}) {
  const listXml = lists.map((title) => `
        <pnp:ListInstance Title="${title}" Description="" DocumentTemplate="" OnQuickLaunch="true" TemplateType="101" Url="${title.replace(/\s/g, '')}" EnableVersioning="true" MaxVersionLimit="500">
          <pnp:ContentTypeBindings><pnp:ContentTypeBinding ContentTypeID="0x0101" Default="true" /></pnp:ContentTypeBindings>
          <pnp:Views><View DisplayName="All Documents" Url="Forms/AllItems.aspx" /></pnp:Views>
          <pnp:Fields><Field ID="{11111111-0000-4000-8000-000000000001}" Name="KeelRtStatus" StaticName="KeelRtStatus" DisplayName="Status" Type="Choice" /></pnp:Fields>
          <pnp:FieldRefs><pnp:FieldRef ID="22222222-0000-4000-8000-000000000002" Name="KeelRtProject" /></pnp:FieldRefs>
        </pnp:ListInstance>`).join('');
  const navXml = navigation.map((title) => `<pnp:NavigationNode Title="${title}" Url="/sites/KEEL-RT-structure" IsExternal="false" />`).join('');
  return `<?xml version="1.0"?>
<pnp:Provisioning xmlns:pnp="http://schemas.dev.office.com/PnP/2022/09/ProvisioningSchema">
  <pnp:Preferences Generator="${generator}" />
  <pnp:Templates ID="CONTAINER-TEMPLATE-1">
    <pnp:ProvisioningTemplate ID="${id}" Version="1" BaseSiteTemplate="SITEPAGEPUBLISHING#0" Scope="RootSite">
      <pnp:WebSettings Title="KEEL-RT structure &amp; columns" Description="Test site" WelcomePage="SitePages/Home.aspx" NoCrawl="false" QuickLaunchEnabled="true" />
      <pnp:RegionalSettings LocaleId="1033" TimeZone="13" Time24="false" />
      <pnp:SiteFields>
        <Field ID="{22222222-0000-4000-8000-000000000002}" Name="KeelRtProject" StaticName="KeelRtProject" DisplayName="Project" Type="Text" Group="KEEL-RT columns" />
      </pnp:SiteFields>
      <pnp:ContentTypes>
        <pnp:ContentType ID="0x0100AA" Name="KEEL-RT item" Group="KEEL-RT types" Description="" />
      </pnp:ContentTypes>
      <pnp:Lists>${listXml}
      </pnp:Lists>
      <pnp:Features><pnp:SiteFeatures><pnp:Feature ID="b50e3104-6812-424f-a011-cc90e6327318" /></pnp:SiteFeatures><pnp:WebFeatures><pnp:Feature ID="87294c72-f260-42f3-a41b-981a2ffce37a" /></pnp:WebFeatures></pnp:Features>
      <pnp:Navigation><pnp:CurrentNavigation NavigationType="StructuralLocal"><pnp:StructuralNavigation RemoveExistingNodes="true">${navXml}</pnp:StructuralNavigation></pnp:CurrentNavigation></pnp:Navigation>
    </pnp:ProvisioningTemplate>
  </pnp:Templates>
</pnp:Provisioning>`;
}

const HUB = { ID: guid(1), Title: 'KEEL-RT hub', SiteUrl: SITE, SiteId: guid(2), Description: '', LogoUrl: '', SiteDesignId: guid(0), RequiresJoinApproval: false, HideNameInNavigation: false, ParentHubSiteId: guid(0), Context: { internal: true } };
const DESIGN = { Id: guid(3), Title: 'KEEL-RT design', Description: 'd', WebTemplate: '64', SiteScriptIds: [guid(4)], PreviewImageUrl: '', PreviewImageAltText: '', IsDefault: false, Version: 1, DesignPackageId: guid(0) };
const SCRIPT_LISTED = { Id: guid(4), Title: 'KEEL-RT script', Description: 's', Version: 1 };
const SCRIPT_FULL = { ...SCRIPT_LISTED, Content: '{"actions":[{"verb":"createSPList","listName":"KEEL-RT list"}]}' };

/** A fake tenant behind the real jobQueue spawn path. `state` overrides answers. */
function fakeTenant(state = {}) {
  const answers = { hubs: [HUB], designs: [DESIGN], template: template(), ...state };
  const live = fakeCmdletContainer({
    module: 'PnP.PowerShell',
    allowlist: ALLOWED,
    answer: (cmdlet, parameters) => {
      if (answers.error?.[cmdlet]) return { error: answers.error[cmdlet] };
      if (cmdlet === 'Get-PnPHubSite') return answers.hubs;
      if (cmdlet === 'Get-PnPSiteDesign') return answers.designs;
      if (cmdlet === 'Get-PnPSiteScript') return parameters.Identity ? [SCRIPT_FULL] : [SCRIPT_LISTED];
      if (cmdlet === 'Get-PnPSiteTemplate') return typeof answers.template === 'function' ? answers.template(parameters.Url) : [answers.template];
      return [];
    },
  });
  return { ...live, answers };
}

const read = (live, extra = {}) => readSharePointStructure({ powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => NOW, ...extra });

test('the reads are declared, in scope, probed, Get-only and ship disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === SHAREPOINT_STRUCTURE_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...SHAREPOINT_STRUCTURE_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), ['Get-PnPHubSite', 'Get-PnPSiteDesign', 'Get-PnPSiteScript', 'Get-PnPSiteTemplate']);
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const spo = /# --- SharePoint \/ PnP ---([\s\S]*)$/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'PnP.PowerShell');
    assert.deepEqual(descriptor.rbac, { permissions: ['Sites.FullControl.All'], roles: ['SharePoint Administrator'] });
    assert.ok(spo.includes(`name = "${descriptor.operation.probeName}"; block = { ${descriptor.operation.probeName} }`), descriptor.id);
  }
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(bare.rows.filter((row) => row.id.startsWith('sharepoint-structure.')).every((row) => row.enabled === false));
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(SHAREPOINT_STRUCTURE_DESCRIPTOR.enabledByDefault, false);
  assert.equal(SHAREPOINT_STRUCTURE_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === SHAREPOINT_STRUCTURE_WORKLOAD));
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === SHAREPOINT_STRUCTURE_WORKLOAD && entry.powershellFamily === 'sharepoint'));
  // The writes live in their own module and allowlist (sharepoint-structure-restore.test.mjs); the read path never runs them.
  assert.deepEqual(Object.entries(WORKLOAD_WRITE_OPERATIONS).filter(([, operation]) => operation.workload === SHAREPOINT_STRUCTURE_WORKLOAD).map(([id]) => id).sort(), [
    'sharepoint-structure.hub-site.add', 'sharepoint-structure.hub-site.update', 'sharepoint-structure.site-design.add', 'sharepoint-structure.site-design.update',
    'sharepoint-structure.site-script.add', 'sharepoint-structure.site-script.update', 'sharepoint-structure.site-template.update',
  ]);

  assert.deepEqual(Object.fromEntries(Object.entries(SHAREPOINT_STRUCTURE_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Invoke-PnPSiteTemplate', 'Add-PnPHubSiteAssociation', 'Set-PnPSiteDesign', 'Remove-PnPSiteScript', 'Get-PnPListItem', 'Get-PnPFile', 'Get-PnPTermGroup']) {
    assert.throws(() => assertSharePointStructureCmdlet({ cmdlet }), SharePointStructureScopeError, cmdlet);
  }
  assert.throws(() => assertSharePointStructureCmdlet({ cmdlet: 'Get-PnPSiteTemplate', parameters: { Handlers: 'All' } }), /does not take Handlers/);
  assert.throws(() => assertSharePointStructureCmdlet({ cmdlet: 'Get-PnPHubSite', parameters: { Identity: 'x' } }), /does not take Identity/);

  assert.equal(readModule(SHAREPOINT_STRUCTURE_WORKLOAD), 'PnP.PowerShell');
  assert.deepEqual(workloadReads(SHAREPOINT_STRUCTURE_WORKLOAD).map((item) => item.family), ['hubSite', 'siteDesign', 'siteScript', 'siteTemplate']);
});

test('the container reads structure only, on a site collection root of the tenant host', () => {
  const handlers = /\$SiteTemplateHandlers = '([^']+)'/.exec(SCRIPT)[1].split(',').map((name) => name.trim());
  assert.ok(handlers.includes('Lists') && handlers.includes('Fields') && handlers.includes('ContentTypes') && handlers.includes('Navigation'));
  for (const content of ['All', 'SiteSecurity', 'Files', 'Pages', 'PageContents', 'TermGroups', 'PropertyBagEntries', 'Publishing', 'Workflows']) {
    assert.ok(!handlers.includes(content), `${content} is never exported`);
  }
  // -Url is consumed by the connection and the handlers are set by the container, never the job.
  assert.match(SCRIPT, /\$pnpUrl = Get-KeelSiteUrl -Value \(\[string\]\$params\['Url'\]\)/);
  assert.match(SCRIPT, /\$params\.Remove\('Url'\)\s+\$params\['Handlers'\] = \$SiteTemplateHandlers/);
  assert.match(SCRIPT, /Connect-PnPOnline -Url \$pnpUrl /);
  assert.match(SCRIPT, /-notmatch '\^\/\(sites\|teams\)\/\[A-Za-z0-9_\.-\]\+\$'/);
});

test('only named site collection roots on the tenant host are template sites', () => {
  assert.equal(structureSite(`${SITE}/`, HOST), SITE);
  assert.equal(structureSite(`https://${HOST.toUpperCase()}/Teams/KEEL-RT-team`, HOST), `https://${HOST}/teams/KEEL-RT-team`);
  assert.equal(structureSite(`https://${HOST}`, HOST), `https://${HOST}`);
  for (const value of [
    'https://fabrikam.sharepoint.com/sites/x', `http://${HOST}/sites/x`, `${SITE}/subsite`, `${SITE}/Shared%20Documents`,
    `https://${HOST}/personal/ada`, `${SITE}?a=1`, `${SITE}#x`, `https://user:pw@${HOST}/sites/x`, `https://${HOST}:8443/sites/x`, 'not a url', '',
  ]) {
    assert.throws(() => structureSite(value, HOST), SharePointStructureScopeError, value);
  }
  assert.throws(() => structureSite(SITE, 'contoso-admin.example.com'), TypeError);
});

test('each object is one observation with declared fields; scripts are read by id; templates keep summaries and the XML', async () => {
  const live = fakeTenant();
  const result = await read(live);
  assert.equal(result.outcome, 'complete', JSON.stringify(result.failures));
  assert.deepEqual(live.calls, [
    { cmdlet: 'Get-PnPHubSite', parameters: {} },
    { cmdlet: 'Get-PnPSiteDesign', parameters: {} },
    { cmdlet: 'Get-PnPSiteScript', parameters: {} },
    { cmdlet: 'Get-PnPSiteScript', parameters: { Identity: guid(4) } },
    { cmdlet: 'Get-PnPSiteTemplate', parameters: { Url: SITE } },
  ]);
  const byKey = Object.fromEntries(result.resources.map((resource) => [resource.resourceKey, resource]));
  assert.deepEqual(Object.keys(byKey), [`hub-site:${guid(1)}`, `site-design:${guid(3)}`, `site-script:${guid(4)}`, `site-template:${SITE.toLowerCase()}`]);
  assert.deepEqual(Object.keys(byKey[`hub-site:${guid(1)}`].fields), [...FAMILIES.hubSite.fields]);
  assert.equal(byKey[`hub-site:${guid(1)}`].fields.Context, undefined, 'undeclared properties are dropped');
  assert.equal(byKey[`site-script:${guid(4)}`].fields.Content, SCRIPT_FULL.Content);

  const site = byKey[`site-template:${SITE.toLowerCase()}`];
  assert.deepEqual(Object.keys(site.fields).sort(), [...FAMILIES.siteTemplate.fields].sort());
  assert.equal(site.fields.title, 'KEEL-RT structure & columns');
  assert.deepEqual(site.fields.lists, [{
    Title: 'Documents', Url: 'Documents', TemplateType: '101', Description: '', OnQuickLaunch: 'true', EnableVersioning: 'true', MaxVersionLimit: '500',
    contentTypes: ['0x0101'], columns: ['KeelRtStatus'], siteColumns: ['KeelRtProject'], views: ['All Documents'],
  }]);
  assert.deepEqual(site.fields.contentTypes, [{ ID: '0x0100AA', Name: 'KEEL-RT item', Group: 'KEEL-RT types', Description: '' }]);
  assert.deepEqual(site.fields.siteColumns.map((field) => field.Name), ['KeelRtProject'], 'list columns are not site columns');
  assert.deepEqual(site.fields.navigation, [{ Title: 'Home', Url: '/sites/KEEL-RT-structure', IsExternal: 'false' }]);
  assert.deepEqual(site.fields.siteFeatures, [{ ID: 'b50e3104-6812-424f-a011-cc90e6327318' }]);
  assert.deepEqual(site.fields.webFeatures, [{ ID: '87294c72-f260-42f3-a41b-981a2ffce37a' }]);
  assert.equal(site.fields.regionalSettings.LocaleId, '1033');
  assert.equal(gunzipSync(Buffer.from(site.fields.templateXml, 'base64')).toString('utf8'), template(), 'the whole template is kept for a restore');
  assert.equal(site.fields.templateBytes, Buffer.byteLength(template()));
  assert.equal(site.fieldCoverage.templateXml.encoding, 'gzip+base64');
  assert.ok(Object.values(site.fieldCoverage).every((coverage) => coverage.status === 'observed' && coverage.operation === 'sharepoint-structure.site-templates'));

  // PnP's own template id and version move on every export; the digest ignores them.
  const again = await read(fakeTenant({ template: template({ id: 'TEMPLATE-2', generator: 'PnP.Framework, 1.18.0' }) }), { families: ['siteTemplate'] });
  assert.equal(again.resources[0].fields.templateSha256, site.fields.templateSha256);
  const changed = await read(fakeTenant({ template: template({ lists: ['Documents', 'KEEL-RT tasks'] }) }), { families: ['siteTemplate'] });
  assert.notEqual(changed.resources[0].fields.templateSha256, site.fields.templateSha256);
});

test('templates: no site named, a site out of scope, a bad or huge answer and a failed site are never silent', async () => {
  const none = fakeTenant();
  const unconfigured = await read(none, { families: ['siteTemplate'], sites: [] });
  assert.deepEqual(none.calls, [], 'nothing is sent without a named site');
  assert.equal(unconfigured.outcome, 'failed');
  assert.equal(unconfigured.discovery.families.siteTemplate.status, 'not-configured');
  assert.match(workloadGapReasons(unconfigured).join('\n'), /no sites are named for the structure backup/);

  const mixed = fakeTenant({
    template: (url) => (url.endsWith('broken') ? { error: { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } } : [template()]),
  });
  const result = await read(mixed, { families: ['siteTemplate'], sites: [SITE, SITE.toUpperCase().replace('HTTPS', 'https'), 'https://fabrikam.sharepoint.com/sites/x', `https://${HOST}/sites/broken`] });
  assert.deepEqual(mixed.calls.map((call) => call.parameters.Url), [SITE, `https://${HOST}/sites/broken`], 'out-of-scope and repeated sites are not sent');
  assert.equal(result.outcome, 'partial');
  assert.equal(result.resources.length, 1);
  assert.deepEqual(result.failures.map((failure) => failure.status), ['refused', 'denied']);

  for (const [answer, code] of [[[], 'BAD_TEMPLATE'], [['<html/>'], 'BAD_TEMPLATE'], [[{ Templates: [] }], 'BAD_TEMPLATE'], [[template(), template()], 'BAD_TEMPLATE'],
    [[`${template()}<!--${'x'.repeat(MAX_TEMPLATE_BYTES)}-->`], 'TOO_LARGE']]) {
    const bad = await read(fakeTenant({ template: () => answer }), { families: ['siteTemplate'] });
    assert.equal(bad.outcome, 'failed', code);
    assert.equal(bad.failures[0].error.code, code);
  }

  // A scope file naming sites but no host: the templates say why, the other reads still run.
  const noHost = await read(fakeTenant(), { tenantHost: null });
  assert.equal(noHost.outcome, 'partial');
  assert.equal(noHost.discovery.families.siteTemplate.status, 'not-configured');
  assert.equal(noHost.discovery.families.hubSite.status, 'read');
  assert.equal(noHost.failures[0].error.code, 'NO_HOST');

  const capped = await read(fakeTenant(), { families: ['siteTemplate'], sites: [SITE, `https://${HOST}/sites/KEEL-RT-two`], maxSites: 1 });
  assert.equal(capped.outcome, 'partial');
  assert.equal(capped.discovery.capped, true);
});

test('a hub as PnP returns it (no Targets) is read in full, so the workload is complete (#664)', async () => {
  assert.equal(FAMILIES.hubSite.fields.includes('Targets'), false, 'Targets never arrives from Get-PnPHubSite, so it is not declared');
  const result = await read(fakeTenant(), { families: ['hubSite'] });
  assert.equal(result.outcome, 'complete', JSON.stringify(result.failures));
  const hub = result.resources.find((resource) => resource.resourceKey === `hub-site:${guid(1)}`);
  assert.ok(Object.values(hub.fieldCoverage).every((coverage) => coverage.status === 'observed'), JSON.stringify(hub.fieldCoverage));
});

test('hub sites, designs and scripts: an empty tenant is complete, a failure is a failure', async () => {
  const empty = await read(fakeTenant({ hubs: [], designs: [] }), { families: ['hubSite', 'siteDesign'] });
  assert.equal(empty.outcome, 'complete-empty');
  const denied = await read(fakeTenant({ error: { 'Get-PnPHubSite': { message: 'Access denied', category: 'PermissionDenied', errorId: 'x' } } }), { families: ['hubSite'] });
  assert.equal(denied.outcome, 'failed');
  assert.equal(denied.failures[0].status, 'denied');
  // An answer KEEL cannot identify is never kept as an empty success.
  // A script deleted between the list and its read is a failure, not a quiet gap.
  const vanished = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: ALLOWED, answer: (cmdlet, parameters) => (parameters.Identity ? [] : [SCRIPT_LISTED]) });
  const gone = await readSharePointStructure({ powershell: vanished.powershell, families: ['siteScript'], now: () => NOW });
  assert.equal(gone.outcome, 'failed');
  assert.equal(gone.failures[0].error.code, 'NOT_FOUND');
  const unidentified = await read(fakeTenant({ designs: [{ ...DESIGN, Id: 'nope' }] }), { families: ['siteDesign'] });
  assert.equal(unidentified.outcome, 'failed');
  const someUnidentified = await read(fakeTenant({ designs: [DESIGN, { ...DESIGN, Id: 'nope' }] }), { families: ['siteDesign'] });
  assert.equal(someUnidentified.outcome, 'partial');
});

test('each read turns on with its own proof; a list added to a site is a change, PnP noise is not', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const others = ALL_READS.filter((id) => !SHAREPOINT_STRUCTURE_OPERATIONS.includes(id));
  const off = await collectSharePointStructure(client, { tenantRef, ledger: ledgerWith(tenantRef, others, { now: NOW }), powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => NOW });
  assert.equal(off.run.outcome, 'disabled');
  assert.deepEqual(live.calls, [], 'nothing is sent while disabled');
  assert.match(off.activation.reasons.join('; '), /sharepoint-structure\.hub-sites is fixture-tested/);

  // Hub sites alone: the other reads are skipped, and the run says so.
  const hubsOnly = sharePointStructureActivation(ledgerWith(tenantRef, [...others, 'sharepoint-structure.hub-sites'], { now: NOW }));
  assert.equal(hubsOnly.enabled, true);
  assert.deepEqual(hubsOnly.families, ['hubSite']);
  assert.deepEqual(hubsOnly.skipped.map((entry) => entry.family), ['siteDesign', 'siteScript', 'siteTemplate']);

  const ledger = ledgerWith(tenantRef, ALL_READS, { now: NOW });
  const first = await collectSharePointStructure(client, { tenantRef, ledger, powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => new Date('2026-10-26T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.fields.kind]), [
    [`hub-site:${guid(1)}`, 'hubSite'], [`site-design:${guid(3)}`, 'siteDesign'], [`site-script:${guid(4)}`, 'siteScript'], [`site-template:${SITE.toLowerCase()}`, 'siteTemplate'],
  ]);
  assert.equal(rows[3].fields.url, SITE);

  // A new export with only PnP's own id and version changed: no change.
  live.answers.template = template({ id: 'TEMPLATE-9', generator: 'PnP.Framework, 1.18.0' });
  const second = await collectSharePointStructure(client, { tenantRef, ledger, powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => new Date('2026-10-26T14:00:00Z') });
  await detectWorkloadDrift(client, { collectionId: first.run.id });
  const quiet = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(quiet.drift.length, 0, JSON.stringify(quiet.drift));

  // A list added to the site: one change, on the lists.
  live.answers.template = template({ lists: ['Documents', 'KEEL-RT tasks'] });
  const third = await collectSharePointStructure(client, { tenantRef, ledger, powershell: live.powershell, sites: [SITE], tenantHost: HOST, now: () => new Date('2026-10-27T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: third.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [[`site-template:${SITE.toLowerCase()}`, 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => field.path), ['lists']);
});

test('the read capture needs a site and the admin site of the collector config', () => {
  const config = { sharePointAdminUrl: 'https://contoso-admin.sharepoint.com' };
  assert.deepEqual(readOptionsFor(SHAREPOINT_STRUCTURE_WORKLOAD, { sites: [SITE], collectorConfig: config }), { sites: [SITE], tenantHost: HOST });
  assert.throws(() => readOptionsFor(SHAREPOINT_STRUCTURE_WORKLOAD, { sites: [], collectorConfig: config }), /needs at least one --site/);
  assert.throws(() => readOptionsFor(SHAREPOINT_STRUCTURE_WORKLOAD, { sites: [SITE], collectorConfig: {} }), /no SharePoint admin site/);
  assert.throws(() => readOptionsFor('exchange-mail-flow', { sites: [SITE] }), /--site is only for/);
  assert.deepEqual(readOptionsFor('exchange-mail-flow'), {});
});

test('site structure sits in SharePoint sites, after the site settings', () => {
  const info = typeInfo(SHAREPOINT_STRUCTURE_WORKLOAD);
  assert.equal(info.known, true);
  assert.equal(info.service, 'SharePoint');
  assert.equal(info.categoryName, 'Sites and OneDrive');
  assert.equal(info.name, 'SharePoint site structure');
});

test('the summary reader decodes attributes and keeps list columns apart from site columns', () => {
  const summary = templateSummary(template({ lists: [] }));
  assert.deepEqual(summary.lists, []);
  assert.equal(summary.webSettings.Title, 'KEEL-RT structure & columns');
  assert.deepEqual(templateSummary('<pnp:ProvisioningTemplate ID="x"/>').siteColumns, []);
});
