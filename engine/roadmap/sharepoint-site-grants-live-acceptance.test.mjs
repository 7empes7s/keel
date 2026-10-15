// Gap 5: the live proof for the two site app grant writes.
//
// Acceptance:
//  - a capture on a KEEL-RT- site grants a KEEL-RT- app read, raises it to write,
//    reads both back, and its signed record verifies and imports as two write captures;
//  - a capture refuses a non-KEEL-RT site or app, and writes nothing when the app
//    already holds a grant;
//  - a tampered, unsigned or other-tenant record imports nothing.
//
// The capture runs against an in-memory fake Graph with a test-only key. No tenant
// is read or written, and no record produced here is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { SITE_GRANT_ADD, SITE_GRANT_UPDATE } from '../restore/workloads/sharepointSiteGrants.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { SITE_GRANTS_LIVE_GATE, requiredDocumentation, requiredGrants } from '../../tools/qualification/sharepointSiteGrantsAcceptance.mjs';
import {
  captureSiteGrantsAcceptance, ledgerEvidenceFromSiteGrantsAcceptance, main as liveMain, siteGrantsCapturePlan,
} from '../../tools/qualification/sharepointSiteGrantsLive.mjs';

const KEY = 'test-only';
const tenantRef = tenantRefFor('site-grants-live-fixture');
const build = 'fixture-build';
const host = 'contoso.sharepoint.com';
const FIXTURE_ID = `${host},11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222`;
const OTHER_ID = `${host},33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444`;
const fixtureSiteUrl = `https://${host}/sites/KEEL-RT-20261015`;
const APP = { id: '5555aaaa-5555-4555-8555-555555555555', displayName: 'KEEL-RT-grant-app' };
const observed = new Date('2026-10-15T08:00:00Z');
const verifyNow = new Date('2026-10-15T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-site-grants-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeGraph({ existing = [], refusePatch = false } = {}) {
  const sites = {
    [FIXTURE_ID]: { id: FIXTURE_ID, webUrl: fixtureSiteUrl, name: 'KEEL-RT-20261015' },
    [OTHER_ID]: { id: OTHER_ID, webUrl: `https://${host}/sites/HR`, name: 'HR' },
  };
  const grants = { [FIXTURE_ID]: structuredClone(existing), [OTHER_ID]: [{ id: 'hr-grant', roles: ['write'], grantedToIdentitiesV2: [{ application: { id: 'x' } }] }] };
  const calls = [];
  const transport = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: decodeURIComponent(pathname), body: init?.body ?? null });
    const path = decodeURIComponent(pathname);
    if (path === '/v1.0/sites/getAllSites' && method === 'GET') return { status: 200, headers: {}, body: { value: Object.values(sites) } };
    const match = /^\/v1\.0\/sites\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(path);
    if (match && grants[match[1]]) {
      const list = grants[match[1]];
      if (method === 'GET' && !match[2]) return { status: 200, headers: {}, body: { value: structuredClone(list) } };
      if (method === 'POST' && !match[2]) {
        const grant = { id: 'aTowaS50fG1zLnNwLmV4dHw1NTU1', roles: [...init.body.roles], grantedToIdentitiesV2: structuredClone(init.body.grantedToIdentities) };
        list.push(grant);
        return { status: 201, headers: {}, body: structuredClone(grant) };
      }
      const grant = list.find((item) => item.id === match[2]);
      if (method === 'PATCH' && grant) {
        if (refusePatch) return { status: 403, headers: {}, body: null };
        grant.roles = [...init.body.roles];
        return { status: 200, headers: {}, body: structuredClone(grant) };
      }
    }
    return { status: 404, headers: {}, body: null };
  };
  return { transport, calls, grants };
}

const documentation = () => requiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-14T12:00:00Z' }));
const capture = (graph, overrides = {}) => captureSiteGrantsAcceptance({
  collector: graph.transport, restorer: graph.transport, tenantHost: host, fixtureSiteUrl, appId: APP.id, appName: APP.displayName,
  tenantRef, build, credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' },
  grants: requiredGrants(), documentation: documentation(), now: () => observed, sleep: async () => {}, readBackDelayMs: 0, ...overrides,
});
let counter = 0;
async function captured(graph, overrides) {
  const result = await capture(graph, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };

test('a capture grants the KEEL-RT app read, raises it to write, and its record imports as two write captures', async () => {
  const graph = fakeGraph();
  const { evidence } = await captured(graph);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => [call.method, call.path]), [
    ['POST', `/v1.0/sites/${FIXTURE_ID}/permissions`],
    ['PATCH', `/v1.0/sites/${FIXTURE_ID}/permissions/aTowaS50fG1zLnNwLmV4dHw1NTU1`],
  ]);
  assert.deepEqual(writes[0].body, { roles: ['read'], grantedToIdentities: [{ application: APP }] });
  assert.deepEqual(writes[1].body, { roles: ['write'] });
  // No other site is addressed, and the grant stays (KEEL never deletes one).
  assert.ok(graph.calls.every((call) => !call.path.includes(OTHER_ID)));
  assert.deepEqual(graph.grants[FIXTURE_ID][0].roles, ['write']);

  const verified = verifyEvidence(evidence, { ...seamOptions, gate: SITE_GRANTS_LIVE_GATE, requireLive: true });
  assert.equal(verified.ok, true, verified.failures.join('; '));
  // The record is pseudonymized: the tenant's ids never reach the repository.
  assert.equal(JSON.stringify(evidence).includes(APP.id), false);

  const seam = ledgerEvidenceFromSiteGrantsAcceptance(evidence, seamOptions);
  assert.equal(seam.ok, true, seam.failures.join('; '));
  assert.deepEqual(seam.writes.map((item) => [item.operationId, item.kind, item.readBackVerified]), [
    [SITE_GRANT_ADD, 'live-write-capture', true], [SITE_GRANT_UPDATE, 'live-write-capture', true],
  ]);
  assert.ok(seam.restorerGrants.permissions.includes('Sites.FullControl.All'));
  // With the read enabled, each imported capture enables exactly its own write.
  const readLedger = { tenantRef, rows: [{ id: 'sharepoint.site-permissions', state: 'live-qualified', enabled: true }] };
  for (const id of [SITE_GRANT_ADD, SITE_GRANT_UPDATE]) {
    assert.equal(workloadWriteQualification(id, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow }).enabled, true, id);
  }
});

test('a capture writes nothing outside the fixtures, or when the app already holds a grant', async () => {
  assert.throws(() => siteGrantsCapturePlan({ tenantHost: host, fixtureSiteUrl: `https://${host}/sites/HR`, appId: APP.id, appName: APP.displayName }), /KEEL rehearsal site/);
  assert.throws(() => siteGrantsCapturePlan({ tenantHost: host, fixtureSiteUrl, appId: APP.id, appName: 'Payroll' }), /KEEL-RT-\* test application/);
  assert.equal(siteGrantsCapturePlan({ tenantHost: host, fixtureSiteUrl, appId: APP.id, appName: APP.displayName }).filter((step) => step.method !== 'GET').length, 2);

  const holding = fakeGraph({ existing: [{ id: 'old', roles: ['read'], grantedToIdentitiesV2: [{ application: APP }] }] });
  const { evidence } = await captured(holding);
  assert.equal(holding.calls.filter((call) => call.method !== 'GET').length, 0);
  assert.match(evidence.subject.writes[0].error, /already holds a grant/);
  assert.equal(ledgerEvidenceFromSiteGrantsAcceptance(evidence, seamOptions).ok, false);

  // A refused update leaves the add proven but the record does not verify.
  const refusing = fakeGraph({ refusePatch: true });
  const partial = await captured(refusing);
  assert.equal(partial.evidence.subject.writes[1].ok, false);
  assert.equal(ledgerEvidenceFromSiteGrantsAcceptance(partial.evidence, seamOptions).ok, false);

  // The CLI refuses a capture without the explicit confirmation.
  const lines = [];
  const code = await liveMain(['capture', '--tenant-host', host, '--fixture-site-url', fixtureSiteUrl, '--app-id', APP.id, '--app-name', APP.displayName], { out: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
});

test('a tampered, unsigned or other-tenant record imports nothing', async () => {
  const { evidence } = await captured(fakeGraph());
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    mutate(copy);
    const { proof: { runner, ...proof }, ...rest } = copy;
    return signEvidence({ ...rest, proof }, KEY, 'keel-release-runner');
  };
  const cases = {
    unsigned: (() => { const { proof: { runner, ...proof }, ...rest } = structuredClone(evidence); return { ...rest, proof }; })(),
    readBackFalse: resign((e) => { e.subject.writes[0].readBackVerified = false; }),
    otherSite: resign((e) => { e.subject.requests[0].path = `/sites/${encodeURIComponent(OTHER_ID)}/permissions`; }),
    extraWrite: resign((e) => { e.subject.requests.push({ ...e.subject.requests.find((r) => r.method === 'POST') }); }),
    collectorWrites: resign((e) => { e.subject.requests.find((r) => r.method === 'PATCH').credential = 'collector'; }),
    notFixtureApp: resign((e) => { e.subject.application.displayName = 'Payroll'; }),
    synthetic: resign((e) => { e.subject.writes[1].synthetic = true; }),
    sameCredential: resign((e) => { e.subject.credentials.restorer = e.subject.credentials.collector; }),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(ledgerEvidenceFromSiteGrantsAcceptance(record, seamOptions).ok, false, name);
  }
  assert.equal(ledgerEvidenceFromSiteGrantsAcceptance(evidence, { ...seamOptions, tenantRef: tenantRefFor('other') }).ok, false);
  assert.equal(ledgerEvidenceFromSiteGrantsAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
});
