import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { pseudonymizeCapture, pseudonymizer } from './pseudonymize.mjs';

const TENANT = '73b6beef-0000-4000-8000-000000000001';
const APP = '87aa77c4-0000-4000-8000-000000000002';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
