// Gap 4: the live proof for the five site permission writes.
//
// Acceptance:
//  - a capture on a KEEL-RT- site creates a KEEL-RT- level and group, adds a KEEL-RT- test
//    user to the group and as a site collection admin, grants the group the level on the
//    site and on a list, reads every write back, and its signed record verifies and
//    imports as five write captures that enable exactly those writes;
//  - a capture refuses a non-KEEL-RT site, label or user, and writes nothing when its
//    fixture already exists;
//  - a tampered, unsigned or other-tenant record imports nothing.
//
// The capture runs against an in-memory fake SharePoint REST API with a test-only key. No
// tenant is read or written, and no record produced here is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { SITE_PERMISSION_WRITE_OPERATIONS } from '../restore/workloads/sharepointSitePermissions.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { HOST, LIST, WEB_URL, backupState, fakeSharePoint, login } from '../test/fakeSharePointRest.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import {
  SITE_PERMISSIONS_LIVE_GATE, SITE_PERMISSIONS_LIVE_WRITES, requiredDocumentation, requiredGrants,
} from '../../tools/qualification/sharepointSitePermissionsAcceptance.mjs';
import {
  captureSitePermissionsAcceptance, ledgerEvidenceFromSitePermissionsAcceptance, main as liveMain, sitePermissionsCapturePlan,
} from '../../tools/qualification/sharepointSitePermissionsLive.mjs';

const KEY = 'test-only';
const tenantRef = tenantRefFor('site-permissions-live-fixture');
const build = 'fixture-build';
const LABEL = 'KEEL-RT-perm-1';
const MEMBER = login('keel-rt-tester');
const observed = new Date('2026-10-15T08:00:00Z');
const verifyNow = new Date('2026-10-15T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-site-permissions-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const documentation = () => requiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-14T12:00:00Z' }));
const options = { tenantHost: HOST, fixtureSiteUrl: WEB_URL, label: LABEL, member: MEMBER, listId: LIST };
const capture = (site, overrides = {}) => captureSitePermissionsAcceptance({
  collector: site.transport, restorer: site.transport, ...options, tenantRef, build,
  credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' },
  grants: requiredGrants(), documentation: documentation(), now: () => observed, sleep: async () => {}, readBackDelayMs: 0, ...overrides,
});
let counter = 0;
async function captured(site, overrides) {
  const result = await capture(site, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
const writePaths = (site) => site.writes().map((request) => `${request.method} ${decodeURIComponent(new URL(request.url).pathname).replace('/sites/KEEL-RT-20261015/_api/', '')}`);

test('a capture adds a KEEL-RT level, group, member, admin and role assignments, and imports as five write captures', async () => {
  const site = fakeSharePoint(backupState());
  const { evidence } = await captured(site);
  // The fake gives the new level id 101 and the new group id 102; the test user is 28.
  assert.deepEqual(writePaths(site), [
    'POST web/roledefinitions',
    'POST web/sitegroups',
    'POST web/sitegroups/getbyid(102)/users',
    'POST web/ensureuser',
    'POST web/siteusers/getbyid(28)',
    'POST web/roleassignments/addroleassignment(principalid=102,roledefid=101)',
    `POST web/lists(guid'${LIST}')/roleassignments/addroleassignment(principalid=102,roledefid=101)`,
  ]);
  // The level copies the site's Read permissions; nothing is removed afterwards.
  assert.deepEqual(site.writes()[0].body.BasePermissions, { High: '176', Low: '138612833' });
  assert.ok(site.state.groups.some((group) => group.Title === `${LABEL} group` && group.members.includes('keel-rt-tester')));
  assert.ok(site.state.admins.includes('keel-rt-tester'));

  const verified = verifyEvidence(evidence, { ...seamOptions, gate: SITE_PERMISSIONS_LIVE_GATE, requireLive: true });
  assert.equal(verified.ok, true, verified.failures.join('; '));
  // The record is pseudonymized: the tenant's host never reaches the repository.
  assert.equal(JSON.stringify(evidence).includes(HOST), false);

  const seam = ledgerEvidenceFromSitePermissionsAcceptance(evidence, seamOptions);
  assert.equal(seam.ok, true, seam.failures.join('; '));
  assert.deepEqual(seam.writes.map((item) => item.operationId), [...SITE_PERMISSIONS_LIVE_WRITES]);
  assert.deepEqual([...SITE_PERMISSIONS_LIVE_WRITES], [...SITE_PERMISSION_WRITE_OPERATIONS]);
  assert.ok(seam.restorerGrants.permissions.includes('Sites.FullControl.All'));
  // With the read enabled, the imported captures enable exactly these writes.
  const readLedger = { tenantRef, rows: [{ id: 'sharepoint.site-permissions', state: 'live-qualified', enabled: true }] };
  for (const id of SITE_PERMISSION_WRITE_OPERATIONS) {
    assert.equal(workloadWriteQualification(id, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow }).enabled, true, id);
  }
});

test('a capture writes nothing outside the fixtures, or when its fixture already exists', async () => {
  assert.throws(() => sitePermissionsCapturePlan({ ...options, fixtureSiteUrl: `https://${HOST}/sites/HR` }), /KEEL rehearsal site/);
  assert.throws(() => sitePermissionsCapturePlan({ ...options, label: 'Payroll' }), /--label must be KEEL-RT-/);
  assert.throws(() => sitePermissionsCapturePlan({ ...options, member: login('alice') }), /KEEL-RT-\* test user/);
  assert.throws(() => sitePermissionsCapturePlan({ ...options, listId: 'Documents' }), /--list-id/);
  assert.throws(() => sitePermissionsCapturePlan({ ...options, listId: undefined }), /--list-id/);
  assert.equal(sitePermissionsCapturePlan(options).filter((step) => step.method !== 'GET').length, 7);

  for (const [name, mutate, reason] of [
    ['group exists', (state) => { state.groups.push({ ...state.groups[0], Id: 50, Title: `${LABEL} group` }); }, /already exists/],
    ['already admin', (state) => { state.admins.push('keel-rt-tester'); }, /already a site collection admin/],
    ['inherits', (state) => { state.web.HasUniqueRoleAssignments = false; }, /inherits its permissions/],
  ]) {
    const state = backupState();
    mutate(state);
    const site = fakeSharePoint(state);
    const { evidence } = await captured(site);
    assert.equal(site.writes().length, 0, name);
    assert.match(evidence.subject.writes[0].error, reason, name);
    assert.equal(ledgerEvidenceFromSitePermissionsAcceptance(evidence, seamOptions).ok, false, name);
  }

  // A refused write stops the capture; the record does not verify.
  const refusing = fakeSharePoint(backupState(), { onWrite: (api) => (api.startsWith('web/siteusers') ? { status: 403, headers: {}, body: null } : null) });
  const partial = await captured(refusing);
  assert.equal(partial.evidence.subject.writes.find((item) => item.operationId === 'sharepoint.site-admins.add').ok, false);
  assert.ok(!writePaths(refusing).some((line) => line.includes('addroleassignment')));
  assert.equal(ledgerEvidenceFromSitePermissionsAcceptance(partial.evidence, seamOptions).ok, false);

  // The CLI refuses a capture without the explicit confirmation.
  const lines = [];
  const code = await liveMain(['capture', '--tenant-host', HOST, '--fixture-site-url', WEB_URL, '--label', LABEL, '--member', MEMBER, '--list-id', LIST], { out: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
});

test('a tampered, unsigned or other-tenant record imports nothing', async () => {
  const { evidence } = await captured(fakeSharePoint(backupState()));
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    mutate(copy);
    const { proof: { runner, ...proof }, ...rest } = copy;
    return signEvidence({ ...rest, proof }, KEY, 'keel-release-runner');
  };
  const firstPost = (e) => e.subject.requests.find((r) => r.method === 'POST');
  const cases = {
    unsigned: (() => { const { proof: { runner, ...proof }, ...rest } = structuredClone(evidence); return { ...rest, proof }; })(),
    readBackFalse: resign((e) => { e.subject.writes[2].readBackVerified = false; }),
    otherSite: resign((e) => { e.subject.requests[0].path = e.subject.requests[0].path.replace('KEEL-RT-20261015', 'HR'); }),
    extraWrite: resign((e) => { e.subject.requests.push({ ...firstPost(e) }); }),
    removeWrite: resign((e) => { e.subject.requests.push({ ...firstPost(e), path: firstPost(e).path.replace('web/roledefinitions', 'web/roleassignments/removeroleassignment(principalid=1,roledefid=2)') }); }),
    collectorWrites: resign((e) => { firstPost(e).credential = 'collector'; }),
    oneScope: resign((e) => { e.subject.writes.find((w) => w.operationId === 'sharepoint.site-role-assignments.add').scopes = 1; }),
    noList: resign((e) => { delete e.subject.fixture.listId; }),
    noListWrite: resign((e) => { e.subject.requests = e.subject.requests.filter((r) => !r.path.includes('lists(guid')); }),
    notFixtureUser: resign((e) => { e.subject.fixture.member = 'i:0#.f|membership|alice@x.onmicrosoft.com'; }),
    notFixtureGroup: resign((e) => { e.subject.fixture.group = 'Owners'; }),
    otherSubject: resign((e) => { e.subject.writes[1].subject = 'Owners'; }),
    synthetic: resign((e) => { e.subject.writes[1].synthetic = true; }),
    sameCredential: resign((e) => { e.subject.credentials.restorer = e.subject.credentials.collector; }),
    missingWrite: resign((e) => { e.subject.writes.pop(); }),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(ledgerEvidenceFromSitePermissionsAcceptance(record, seamOptions).ok, false, name);
  }
  assert.equal(ledgerEvidenceFromSitePermissionsAcceptance(evidence, { ...seamOptions, tenantRef: tenantRefFor('other') }).ok, false);
  assert.equal(ledgerEvidenceFromSitePermissionsAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
});
