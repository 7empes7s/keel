// #447 for service backups: a partial workload run names what it could not read, from
// its stored digest, as short "what: why" lines. Never a raw family key or an object id.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { familyWords, workloadGapReasons } from './gaps.mjs';

test('family keys read as words', () => {
  assert.equal(familyWords('transportRule'), 'Transport rule');
  assert.equal(familyWords('dlp-compliance_policy'), 'DLP compliance policy');
  assert.equal(familyWords(undefined), 'Part of this backup');
});

test('a cmdlet-family digest lists each gap once, with a plain cause', () => {
  const digest = {
    failures: [
      { family: 'transportRule', operation: 'mailflow.transport-rules', status: 'denied', error: { code: 'HTTP_403', httpStatus: 403, message: 'Access is denied' } },
      { family: 'retentionRule', status: 'failed', parent: '00000000-0000-4000-8000-000000000001', error: { code: 'ERROR', message: 'timed out\n after 60s' } },
      { family: 'retentionRule', status: 'failed', parent: '00000000-0000-4000-8000-000000000002', error: { code: 'ERROR', message: 'timed out\n after 60s' } },
    ],
    unavailable: [{ family: 'atpPolicy', status: 'not-licensed', license: 'Defender for Office 365 Plan 1' }],
    skipped: ['journalRule'],
    discovery: { capped: true, maxObjects: 500, unidentified: 2, unparented: 1, conflicts: [{}], empty: ['teamsMeetingPolicy'] },
    fieldCounts: { observed: 40, denied: 3, 'not-returned': 1 },
    reasons: [],
  };
  const lines = workloadGapReasons(digest);
  assert.deepEqual(lines, [
    'Transport rule: access denied: HTTP 403: Access is denied',
    'Retention rule: timed out after 60s (2 times)',
    'ATP policy: not licensed in this tenant (Defender for Office 365 Plan 1)',
    'Journal rule: not switched on yet, so it was not read',
    'Teams meeting policy: Microsoft returned nothing, though a working tenant always has some',
    'More objects than one run reads (the limit is 500)',
    '2 objects: returned without an identity, so they could not be kept',
    '1 object: its parent was not read',
    '1 object: two answers with the same identity',
    '3 settings: not read (access denied)',
    '1 setting: not read (not returned)',
  ]);
  assert.ok(lines.every((line) => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(line)), 'no object id is listed');
});

test('settings Microsoft did not return are named, never counted as "unknown"', () => {
  assert.deepEqual(workloadGapReasons({
    fieldCounts: { observed: 30, unknown: 3 },
    unknownFields: { retentionLabel: { EventType: 2 }, adaptiveScope: { RawQuery: 1 } },
  }), [
    'Retention label: event type was not returned (2 objects)',
    'Adaptive scope: raw query was not returned (1 object)',
  ]);
  // Past five named settings, the rest are counted.
  const many = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((field) => [`Setting${field}`, 1]));
  assert.deepEqual(workloadGapReasons({ fieldCounts: { unknown: 7 }, unknownFields: { teamsMeetingPolicy: many } }).slice(-2), [
    'Teams meeting policy: setting e was not returned (1 object)',
    '2 more settings: not read (not returned)',
  ]);
  // A digest that does not name them still reads in words.
  assert.deepEqual(workloadGapReasons({ fieldCounts: { observed: 30, unknown: 4 } }), ['4 settings: not read (not returned)']);
});

test('an Exchange or OneDrive digest names what was outside the scope', () => {
  const lines = workloadGapReasons({
    discovery: { mailboxes: 2, capped: true, maxMailboxes: 2 },
    outOfScope: [{ identity: 'KEEL-RT-mailbox-3@example.com', reason: 'more than 2 mailboxes were named' }, { site: 'https://example-my.sharepoint.com/personal/x' }],
    fieldCounts: { observed: 10 },
  });
  assert.deepEqual(lines, [
    'More objects than one run reads (the limit is 2)',
    'KEEL-RT-mailbox-3@example.com: more than 2 mailboxes were named',
    'https://example-my.sharepoint.com/personal/x: outside the backup scope',
  ]);
});

test('a capped Teams run names its limit', () => {
  assert.deepEqual(workloadGapReasons({ discovery: { capped: true, maxTeams: 25 } }), ['More objects than one run reads (the limit is 25)']);
});

test('a digest that names nothing gives no lines', () => {
  assert.deepEqual(workloadGapReasons(null), []);
  assert.deepEqual(workloadGapReasons({ fieldCounts: { observed: 3 }, reasons: [] }), []);
  assert.deepEqual(workloadGapReasons({ reasons: ['KEEL-RT-site: not read'] }), ['KEEL-RT-site: not read']);
});
