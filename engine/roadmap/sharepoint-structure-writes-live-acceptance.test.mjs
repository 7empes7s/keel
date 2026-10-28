// The live proof for the SharePoint structure restore's seven writes.
//
// Acceptance:
//  - a capture on a KEEL-RT- site adds a KEEL-RT-capture- site script and design and
//    changes them, changes a KEEL-RT- hub's description and puts it back, registers a
//    KEEL-RT- site as a hub, and adds a KEEL-RT-capture- list, column, content type and
//    navigation link through the restore's own template builder, then puts the
//    navigation back; every write is read back, and the signed record verifies and
//    imports as seven write captures that enable exactly those writes;
//  - a capture refuses a non-KEEL-RT site, and the CLI refuses without confirmation;
//  - a tampered, unsigned, other-tenant or other-build record imports nothing.
//
// The capture runs against the fake PnP tenant of the restore tests with a test-only key.
// No tenant is read or written, and no record produced here is persisted as evidence.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { SHAREPOINT_STRUCTURE_WRITE_OPERATIONS } from '../restore/workloads/sharepointStructureWrites.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { HOST, SITE, fakeTenant, initialState } from '../test/fakePnpStructure.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { STRUCTURE_WRITES_LIVE_GATE, STRUCTURE_WRITES_RECORD_FILE } from '../../tools/qualification/sharepointStructureWritesAcceptance.mjs';
import {
  captureStructureWrites, ledgerEvidenceFromStructureWritesAcceptance, main as liveMain, structureWritesCapturePlan,
} from '../../tools/qualification/sharepointStructureWritesLive.mjs';
import { importSeams } from '../../cli/keel-workload-collect.mjs';

const KEY = 'test-only';
const tenantRef = tenantRefFor('structure-writes-live-fixture');
const build = 'fixture-build';
const HUB_SITE = `https://${HOST}/sites/KEEL-RT-newhub`;
const observed = new Date('2026-10-27T08:00:00Z');
const verifyNow = new Date('2026-10-27T09:00:00Z');
const grants = { restorer: { permissions: ['Sites.FullControl.All'], roles: [] } };

const dir = mkdtempSync(join(tmpdir(), 'keel-structure-writes-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let suffixSeq = 0;
const capture = (live, overrides = {}) => captureStructureWrites({
  collector: live.powershell, restorer: live.powershell, site: SITE, hubSite: HUB_SITE, tenantRef, build, moduleVersion: '3.1.0',
  credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' }, grants,
  now: () => observed, sleep: async () => {}, readBackDelayMs: 0, suffix: () => `c${suffixSeq += 1}`, ...overrides,
});
let counter = 0;
async function captured(live, overrides) {
  const result = await capture(live, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };

test('a capture writes only KEEL-RT fixtures, reads each write back, puts changes back, and imports as seven write captures', async () => {
  const live = fakeTenant();
  const before = structuredClone(live.state);
  const { evidence, needsManualRevert } = await captured(live);
  assert.deepEqual(needsManualRevert, []);
  assert.deepEqual(live.writes.map((write) => write.cmdlet), [
    'Add-PnPSiteScript', 'Set-PnPSiteScript', 'Add-PnPSiteDesign', 'Set-PnPSiteDesign',
    'Set-PnPHubSite', 'Set-PnPHubSite', 'Register-PnPHubSite', 'Invoke-PnPSiteTemplate', 'Invoke-PnPSiteTemplate',
  ]);
  // Every name written is a KEEL-RT- fixture; the design is not the default.
  for (const write of live.writes.filter((item) => item.cmdlet.startsWith('Add-'))) assert.match(write.parameters.Title, /^KEEL-RT-capture-/);
  assert.equal(live.writes.find((item) => item.cmdlet === 'Add-PnPSiteDesign').parameters.IsDefault, false);
  assert.equal(live.writes.find((item) => item.cmdlet === 'Register-PnPHubSite').parameters.Site, HUB_SITE);
  // The first template adds one list, column and content type and a link; it carries no content or permissions.
  const [added, putBack] = live.writes.filter((item) => item.cmdlet === 'Invoke-PnPSiteTemplate');
  assert.equal((added.xml.match(/<pnp:ListInstance\b/g) ?? []).length, 1);
  assert.doesNotMatch(added.xml, /DataRows|Security|PropertyBag|Webhook|CustomAction|Features|WebSettings/);
  assert.doesNotMatch(putBack.xml, /ListInstance|<Field\b|<pnp:ContentType\b/);
  // The hub description and the navigation are as they were; the fixtures stay.
  const site = live.state.sites[SITE.toLowerCase()];
  assert.deepEqual(site.nav, before.sites[SITE.toLowerCase()].nav);
  assert.equal(live.state.hubs[0].Description, before.hubs[0].Description);
  assert.ok(site.lists.some((list) => list.Url.startsWith('Lists/KEEL-RT-capture-')));
  assert.equal(live.state.scripts.length, before.scripts.length + 1);
  assert.equal(live.state.hubs.length, before.hubs.length + 1);

  const verified = verifyEvidence(evidence, { ...seamOptions, gate: STRUCTURE_WRITES_LIVE_GATE, requireLive: true });
  assert.equal(verified.ok, true, verified.failures.join('; '));
  // The record is pseudonymized: the tenant's host never reaches the repository.
  assert.equal(JSON.stringify(evidence).includes(HOST), false);
  // The template body is logged by digest only.
  assert.ok(evidence.subject.requests.every((request) => !('TemplateGzip' in (request.parameters ?? {}))));

  const seam = ledgerEvidenceFromStructureWritesAcceptance(evidence, seamOptions);
  assert.equal(seam.ok, true, seam.failures.join('; '));
  assert.deepEqual(seam.writes.map((item) => item.operationId).sort(), Object.keys(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS).sort());
  const readLedger = { tenantRef, rows: [...new Set(Object.values(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS).map((write) => write.readBack))].map((id) => ({ id, state: 'live-qualified', enabled: true })) };
  for (const id of Object.keys(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS)) {
    const q = workloadWriteQualification(id, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants });
    assert.equal(q.enabled, true, `${id}: ${JSON.stringify(q.reasons)}`);
  }
  // The collector import looks for the record under its own name and treats it as optional.
  const seams = await importSeams();
  assert.ok(seams.some((entry) => entry.file === STRUCTURE_WRITES_RECORD_FILE && entry.optional === true && entry.seam === ledgerEvidenceFromStructureWritesAcceptance));
});

test('a capture refuses non-KEEL-RT sites; a failed write is not proven; the CLI needs confirmation', async () => {
  assert.throws(() => structureWritesCapturePlan({ site: `https://${HOST}/sites/HR` }), /--site must be/);
  assert.throws(() => structureWritesCapturePlan({ site: SITE, hubSite: `https://${HOST}/sites/HR` }), /--hub-site must be/);
  assert.throws(() => structureWritesCapturePlan({ site: SITE, hubSite: 'https://other.sharepoint.com/sites/KEEL-RT-x' }), /same host/);
  const untouched = fakeTenant();
  await assert.rejects(capture(untouched, { site: `https://${HOST}/sites/HR` }), /--site must be/);
  assert.equal(untouched.writes.length, 0);

  // A hub that is not a KEEL-RT- site is never changed; without --hub-site nothing is registered.
  const state = initialState();
  state.hubs[0].SiteUrl = `https://${HOST}/sites/HR`;
  const noHub = fakeTenant(state);
  const { evidence } = await captured(noHub, { hubSite: null });
  assert.ok(!noHub.writes.some((write) => write.cmdlet.endsWith('HubSite')));
  assert.deepEqual(evidence.subject.skipped.map((item) => item.operationId).sort(), ['sharepoint-structure.hub-site.add', 'sharepoint-structure.hub-site.update']);
  const partial = ledgerEvidenceFromStructureWritesAcceptance(evidence, seamOptions);
  assert.equal(partial.ok, true, partial.failures.join('; '));
  assert.equal(partial.writes.length, 5);

  // A write that fails is recorded, not proven; the rest still run.
  const crashing = fakeTenant(initialState(), { crash: ['Add-PnPSiteScript'] });
  const crashed = await captured(crashing);
  const scriptAdd = crashed.evidence.subject.writes.find((item) => item.operationId === 'sharepoint-structure.site-script.add');
  assert.equal(scriptAdd.ok, false);
  assert.match(scriptAdd.error, /may have applied/);
  assert.ok(!crashing.writes.some((write) => write.cmdlet === 'Add-PnPSiteDesign'), 'no design without its script');

  const lines = [];
  const code = await liveMain(['capture', '--site', SITE], { out: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
});

test('a tampered, unsigned, other-tenant or other-build record imports nothing', async () => {
  const { evidence } = await captured(fakeTenant());
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    mutate(copy);
    const { proof: { runner, ...proof }, ...rest } = copy;
    return signEvidence({ ...rest, proof }, KEY, 'keel-release-runner');
  };
  const write = (e, id) => e.subject.writes.find((item) => item.operationId === id);
  const firstWrite = (e) => e.subject.requests.find((request) => request.cmdlet);
  const cases = {
    unsigned: (() => { const { proof: { runner, ...proof }, ...rest } = structuredClone(evidence); return { ...rest, proof }; })(),
    readBackFalse: resign((e) => { e.subject.writes[0].readBackVerified = false; e.subject.writes.splice(1); }),
    notPutBack: resign((e) => { write(e, 'sharepoint-structure.hub-site.update').restoredToOriginal = false; e.subject.writes = [write(e, 'sharepoint-structure.hub-site.update')]; }),
    otherSite: resign((e) => { e.subject.site = e.subject.site.replace(/KEEL-RT-structure/, 'HR'); }),
    notFixtureScript: resign((e) => { write(e, 'sharepoint-structure.site-script.add').fixture = 'Payroll'; }),
    templateNotFixture: resign((e) => { write(e, 'sharepoint-structure.site-template.update').fixture = e.subject.site.replace(/KEEL-RT-structure/, 'HR'); }),
    strippedElement: resign((e) => { write(e, 'sharepoint-structure.site-template.update').elements.push('DataRows'); }),
    removeCmdlet: resign((e) => { e.subject.requests.push({ ...firstWrite(e), cmdlet: 'Remove-PnPSiteScript' }); }),
    collectorWrites: resign((e) => { firstWrite(e).credential = 'collector'; }),
    restorerReads: resign((e) => { e.subject.requests.find((request) => request.read).credential = 'restorer'; }),
    refusalSent: resign((e) => { e.subject.refusals.remove.sent = true; }),
    synthetic: resign((e) => { e.subject.writes[1].synthetic = true; }),
    otherVersion: resign((e) => { e.subject.writes[1].version = '9.9.9'; }),
    sameCredential: resign((e) => { e.subject.credentials.restorer = e.subject.credentials.collector; }),
    capturedTwice: resign((e) => { e.subject.writes.push({ ...e.subject.writes[0] }); }),
    noWrites: resign((e) => { e.subject.writes = []; }),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(ledgerEvidenceFromStructureWritesAcceptance(record, seamOptions).ok, false, name);
  }
  assert.equal(ledgerEvidenceFromStructureWritesAcceptance(evidence, { ...seamOptions, tenantRef: tenantRefFor('other') }).ok, false);
  assert.equal(ledgerEvidenceFromStructureWritesAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
});
