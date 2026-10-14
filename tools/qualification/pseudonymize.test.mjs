import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { LiveGateRefusal, assertSafeText } from './entraLive.mjs';
import {
  cloudSidToGuid, guidToCloudSid, main, pseudonymizeCapture, pseudonymizer, rawIdentifiers, roleAssignmentIdGuids, unpseudonymizedIds,
} from './pseudonymize.mjs';

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

// Graph's id for a directory role assignment: base64url of the role definition's and the
// principal's GUID bytes, then `-1`. Built here from two made-up GUIDs.
const ROLE = '62e90394-69f5-4237-9190-012177145e10';
const toBytes = (value) => {
  const be = Buffer.from(value.replace(/-/g, ''), 'hex');
  return Buffer.from([be[3], be[2], be[1], be[0], be[5], be[4], be[7], be[6], ...be.subarray(8)]);
};
const ASSIGNMENT = `${Buffer.concat([toBytes(ROLE), toBytes(GROUP)]).toString('base64url')}-1`;

test('a role assignment id is pseudonymized through the two GUIDs it encodes (Q48 step 35)', () => {
  assert.deepEqual(roleAssignmentIdGuids(ASSIGNMENT), [ROLE, GROUP]);
  const a = pseudonymizer('sha256:aaaa');
  const out = a.text(ASSIGNMENT);
  assert.notEqual(out, ASSIGNMENT);
  assert.match(out, /^[A-Za-z0-9_-]{43}-1$/, 'keeps its shape and suffix');
  assert.deepEqual(roleAssignmentIdGuids(out), [a.guid(ROLE), a.guid(GROUP)], 'consistent with the GUIDs it names');
  assert.equal(a.text(`/roleManagement/directory/roleAssignments/${ASSIGNMENT}`), `/roleManagement/directory/roleAssignments/${out}`);
  assert.equal(a.walk({ id: ASSIGNMENT, targetId: ASSIGNMENT }).targetId, out);
  // The form without a suffix maps the same way.
  assert.equal(a.text(ASSIGNMENT.slice(0, -2)), out.slice(0, -2));
  // The capture guard knows it as a raw id and refuses it unchanged.
  const raw = rawIdentifiers(JSON.stringify({ id: ASSIGNMENT }));
  assert.deepEqual(raw, [ASSIGNMENT.toLowerCase()]);
  assert.throws(() => assertSafeText(JSON.stringify({ id: ASSIGNMENT }), { rawIds: raw, label: 'the capture log' }), /raw object id/);
  assert.doesNotThrow(() => assertSafeText(JSON.stringify(a.walk({ id: ASSIGNMENT })), { rawIds: raw, label: 'the capture log' }));
  // A 43-character token that does not hold two GUIDs is left alone.
  const hash = createHash('sha256').update('x').digest('base64url');
  assert.equal(roleAssignmentIdGuids(hash), null);
  assert.equal(a.text(hash), hash);
});

test('the check tells pseudonyms from raw ids without the tenant, SIDs included (Q48 steps 1 and 3)', () => {
  const rawCapture = JSON.stringify({ id: GROUP, securityIdentifier: GROUP_SID, assignment: ASSIGNMENT });
  assert.deepEqual(unpseudonymizedIds(rawCapture), [GROUP, GROUP_SID.toLowerCase(), ASSIGNMENT.toLowerCase()]);
  // A pseudonymized group still carries a SID-shaped value, but it encodes the pseudonym id.
  const published = JSON.stringify(pseudonymizer('sha256:aaaa').walk(JSON.parse(rawCapture)));
  assert.match(published, /S-1-12-1-/);
  assert.deepEqual(unpseudonymizedIds(published), []);
  assert.deepEqual(unpseudonymizedIds(ONPREM_SID), [ONPREM_SID.toLowerCase()], 'an on-premises SID cannot be told apart');

  const files = { 'raw.json': rawCapture, 'published.json': published };
  const lines = [];
  const options = { read: (path) => files[path], log: (line) => lines.push(line) };
  assert.equal(main(['check', 'published.json'], options), 0);
  assert.equal(main(['check', 'published.json', 'raw.json'], options), 1);
  assert.match(lines.at(-1), /raw\.json: 3 id\(s\) that are not pseudonyms/);
  assert.equal(main([], options), 2);
});

test('a deleted role assignment id with a longer suffix, a scoped id and a dashless GUID are caught and mapped (#235)', () => {
  const a = pseudonymizer('sha256:aaaa');
  const SCOPE = 'c0ffee00-1111-4222-8333-444455556666';
  const suffixed = `${ASSIGNMENT.slice(0, -2)}-1-e`;
  const scoped = `${Buffer.concat([toBytes(ROLE), toBytes(GROUP), toBytes(SCOPE)]).toString('base64url')}-1`;
  const dashless = GROUP.replace(/-/g, '').toUpperCase();
  assert.deepEqual(roleAssignmentIdGuids(suffixed), [ROLE, GROUP]);
  assert.deepEqual(roleAssignmentIdGuids(scoped), [ROLE, GROUP, SCOPE]);

  const rawLog = { entry: { targetId: suffixed, priorState: { id: suffixed, scoped, objectId: dashless }, outcomeDetail: `DELETE /roleAssignments/${suffixed}` } };
  const raw = JSON.stringify(rawLog);
  assert.deepEqual(unpseudonymizedIds(raw), [GROUP.replace(/-/g, ''), suffixed.toLowerCase(), scoped.toLowerCase()]);

  const published = JSON.stringify(a.walk(rawLog));
  assert.deepEqual(unpseudonymizedIds(published), []);
  for (const id of [suffixed.slice(0, 43), scoped.slice(0, 64), dashless.toLowerCase()]) assert.ok(!published.toLowerCase().includes(id.toLowerCase()), `${id} is gone`);
  const out = a.walk(rawLog).entry;
  assert.equal(out.targetId, out.priorState.id, 'the same id maps the same way everywhere');
  assert.match(out.targetId, /^[A-Za-z0-9_-]{43}-1-e$/, 'keeps its shape and suffix');
  assert.equal(out.outcomeDetail, `DELETE /roleAssignments/${out.targetId}`);
  assert.equal(out.priorState.objectId, a.guid(GROUP).replace(/-/g, ''), 'a dashless GUID maps like its dashed form');
  assert.doesNotThrow(() => assertSafeText(published, { rawIds: rawIdentifiers(raw), label: 'the capture log' }));
  // A sha256 in hex is not a GUID.
  const sha = createHash('sha256').update('x').digest('hex');
  assert.deepEqual(rawIdentifiers(sha), []);
  assert.equal(a.text(sha), sha);
});
