import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { LiveGateRefusal, assertSafeText } from './entraLive.mjs';
import { cloudSidToGuid, guidToCloudSid, pseudonymizeCapture, pseudonymizer, rawIdentifiers } from './pseudonymize.mjs';

const TENANT = '73b6beef-0000-4000-8000-000000000001';
const APP = '87aa77c4-0000-4000-8000-000000000002';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GROUP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GROUP_SID = 'S-1-12-1-2863311530-1288485819-4008631693-4008636142';
const ONPREM_SID = 'S-1-5-21-1004336348-1177238915-682003330-1105';

test('ids and tenant hosts become stable, well-formed pseudonyms that depend on the tenant', () => {
  const a = pseudonymizer('sha256:aaaa');
  assert.match(a.guid(TENANT), GUID_RE);
  assert.equal(a.guid(TENANT), a.guid(TENANT.toUpperCase()));
  assert.notEqual(a.guid(TENANT), a.guid(APP));
  assert.notEqual(a.guid(TENANT), pseudonymizer('sha256:bbbb').guid(TENANT));
  assert.throws(() => pseudonymizer(''), /needs its tenantRef/);

  const host = a.host('contoso');
  assert.match(host, /^t[0-9a-f]{11}$/);
  assert.equal(a.text('https://contoso-my.sharepoint.com/personal/x'), `https://${host}-my.sharepoint.com/personal/x`);
  assert.equal(a.text('contoso.sharepoint.com'), `${host}.sharepoint.com`);
  assert.equal(a.text('contoso-admin.sharepoint.com'), `${host}-admin.sharepoint.com`);
  assert.equal(a.text('bg1@contoso.onmicrosoft.com'), `bg1@${host}.onmicrosoft.com`);
  // Ids after a URL escape and outside SharePoint/onmicrosoft hosts.
  assert.equal(a.text(`/sites/contoso.sharepoint.com%2C${TENANT}`), `/sites/${host}.sharepoint.com%2C${a.guid(TENANT)}`);
  assert.equal(a.text('https://learn.microsoft.com/graph'), 'https://learn.microsoft.com/graph');
  // A %XX escape before the host stays intact and maps like the unescaped form.
  assert.equal(a.text('keel-rt-a%40contoso.onmicrosoft.com'), `keel-rt-a%40${host}.onmicrosoft.com`);
  assert.equal(decodeURIComponent(a.text(encodeURIComponent('keel-rt-a@contoso.onmicrosoft.com'))), a.text('keel-rt-a@contoso.onmicrosoft.com'));
  // An opaque base64 id holding GUIDs (a Teams membership id) is rewritten inside, in both alphabets.
  const raw = `0##${TENANT}##${APP}`;
  for (const encoding of ['base64', 'base64url']) {
    const id = Buffer.from(raw).toString(encoding);
    assert.equal(Buffer.from(a.text(id), encoding).toString(), `0##${a.guid(TENANT)}##${a.guid(APP)}`);
    assert.equal(a.text(`/teams/x/members/${id}`), `/teams/x/members/${a.text(id)}`);
  }
  // Long tokens that are not such ids are left alone.
  for (const token of ['a'.repeat(64), 'keel-rt-20260908-alice_techinsiderbytes_com-long-name']) assert.equal(a.text(token), token);
});

test('a capture loses every raw id, stays consistent with its log, and binds the log digest', () => {
  const log = { requests: [{ path: `/organization/${TENANT}`, credential: `app:${APP}` }], [TENANT]: 'keyed' };
  const record = {
    tenantRef: 'sha256:aaaa', build: 'b'.repeat(40),
    subject: { directoryTenantId: TENANT, credentials: { collector: `app:${APP}` }, site: 'https://contoso.sharepoint.com', captureLogSha256: 'stale' },
  };
  const { record: safe, captureLog } = pseudonymizeCapture({ record, log });
  const text = JSON.stringify(safe) + captureLog;
  for (const raw of [TENANT, APP, 'contoso']) assert.ok(!text.includes(raw), raw);
  const { guid } = pseudonymizer('sha256:aaaa');
  assert.equal(safe.subject.directoryTenantId, guid(TENANT));
  assert.ok(captureLog.includes(`/organization/${guid(TENANT)}`));
  assert.equal(safe.subject.captureLogSha256, createHash('sha256').update(captureLog).digest('hex'));
  assert.equal(safe.tenantRef, record.tenantRef);
  assert.equal(safe.build, record.build);
  assert.equal(record.subject.directoryTenantId, TENANT, 'the input is not mutated');
});

test('a security identifier maps consistently with the GUID it encodes', () => {
  // Cloud SIDs are the object GUID as four little-endian 32-bit words (Guid.ToByteArray order).
  assert.equal(guidToCloudSid(GROUP), GROUP_SID);
  assert.equal(cloudSidToGuid(GROUP_SID), GROUP);
  const a = pseudonymizer('sha256:aaaa');
  const safe = a.text(`${GROUP} ${GROUP_SID}`);
  assert.doesNotMatch(safe, /aaaaaaaa|2863311530/);
  const [guid, sid] = safe.split(' ');
  assert.match(sid, /^S-1-12-1(-\d+){4}$/);
  assert.equal(sid, guidToCloudSid(guid), 'the SID still encodes the pseudonymized GUID');
  assert.equal(a.text(GROUP_SID), sid, 'stable within a run');
  assert.notEqual(pseudonymizer('sha256:bbbb').text(GROUP_SID), sid);
  assert.equal(a.walk({ securityIdentifier: GROUP_SID }).securityIdentifier, sid);
  // An on-premises SID keeps its shape and its domain part across the domain's objects.
  const onPrem = a.text(ONPREM_SID);
  assert.match(onPrem, /^S-1-5-21(-\d+){4}$/);
  assert.notEqual(onPrem, ONPREM_SID);
  assert.equal(onPrem.split('-').slice(0, 7).join('-'), a.text(ONPREM_SID.replace(/-1105$/, '')));
  assert.notEqual(onPrem, a.text(ONPREM_SID.replace(/-1105$/, '-1106')));
  assert.equal(a.text('S-1-5-32-544'), 'S-1-5-32-544', 'well-known SIDs name no object');
  // An immutable id (base64 of the AD objectGUID bytes) maps through the GUID mapping.
  const immutable = Buffer.from('aaaaaaaabbbb4ccc8dddeeeeeeeeeeee', 'hex').toString('base64');
  const walked = a.walk({ onPremisesImmutableId: immutable, note: immutable });
  assert.match(walked.onPremisesImmutableId, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(walked.onPremisesImmutableId, immutable);
  assert.equal(walked.onPremisesImmutableId, a.immutableId(immutable), 'stable within a run');
  assert.equal(a.walk({ onPremisesImmutableId: null }).onPremisesImmutableId, null);
  assert.deepEqual(rawIdentifiers(`${GROUP} ${GROUP_SID} ${ONPREM_SID} ${GROUP}`), [GROUP, GROUP_SID.toLowerCase(), ONPREM_SID.toLowerCase()]);
});

test('the capture guard refuses output that still holds a raw SID of the tenant\'s objects', () => {
  const rawIds = rawIdentifiers(JSON.stringify({ id: GROUP, securityIdentifier: GROUP_SID }));
  const leaked = JSON.stringify({ id: pseudonymizer('sha256:aaaa').guid(GROUP), securityIdentifier: GROUP_SID });
  assert.throws(() => assertSafeText(leaked, { rawTenantId: TENANT, rawIds, label: 'the capture log' }), (error) => error instanceof LiveGateRefusal && /raw object id/.test(error.message));
  assert.throws(() => assertSafeText(leaked.toUpperCase(), { rawTenantId: TENANT, rawIds, label: 'the record' }), LiveGateRefusal);
  const safe = JSON.stringify(pseudonymizer('sha256:aaaa').walk({ id: GROUP, securityIdentifier: GROUP_SID }));
  assert.doesNotThrow(() => assertSafeText(safe, { rawTenantId: TENANT, rawIds, label: 'the capture log' }));
});

test('a securityIdentifier field never reaches a capture raw, whatever its shape', () => {
  const a = pseudonymizer('sha256:aaaa');
  const sid = a.text(GROUP_SID);
  // The Entra form, as Graph returns it on a group, and a lower-cased copy, map the same way.
  assert.equal(a.walk({ securityIdentifier: GROUP_SID }).securityIdentifier, sid);
  assert.equal(a.walk({ securityIdentifier: GROUP_SID.toLowerCase() }).securityIdentifier, sid);
  assert.equal(a.text(`group ${GROUP_SID.toLowerCase()}`), `group ${sid}`);
  assert.deepEqual(rawIdentifiers(GROUP_SID.toLowerCase()), [GROUP_SID.toLowerCase()]);
  // An on-premises SID under the on-premises key.
  assert.equal(a.walk({ onPremisesSecurityIdentifier: ONPREM_SID }).onPremisesSecurityIdentifier, a.text(ONPREM_SID));
  // A shape the text patterns do not know is still replaced, stably, when it sits under the key.
  const odd = 'S-1-12-1-2863311530-1288485819-4008631693';
  const walked = a.walk({ securityIdentifier: odd, nested: [{ securityIdentifier: odd }] });
  assert.match(walked.securityIdentifier, /^S-1-12-1(-\d+){4}$/);
  assert.notEqual(walked.securityIdentifier, odd);
  assert.equal(walked.nested[0].securityIdentifier, walked.securityIdentifier);
  assert.ok(!JSON.stringify(walked).includes('2863311530'));
  // Null and non-SID values are left alone.
  assert.deepEqual(a.walk({ securityIdentifier: null, onPremisesSecurityIdentifier: 'none' }), { securityIdentifier: null, onPremisesSecurityIdentifier: 'none' });
  // A group read-back as Q45 captured it keeps no raw id, and its SID still encodes its id.
  const capture = a.walk({ postState: { id: GROUP, securityIdentifier: GROUP_SID, displayName: 'KEEL-RT-148-group' } });
  const raw = rawIdentifiers(JSON.stringify({ id: GROUP, securityIdentifier: GROUP_SID }));
  assert.doesNotThrow(() => assertSafeText(JSON.stringify(capture), { rawTenantId: TENANT, rawIds: raw, label: 'the capture log' }));
  assert.equal(capture.postState.securityIdentifier, guidToCloudSid(capture.postState.id));
});
