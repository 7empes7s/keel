/**
 * Tests for the reference analyser.
 *
 * This module produces the single number the M1 go/no-go decision rests on, so
 * the fixture is built to distinguish a correct implementation from the naive
 * ones: it contains a self-reference, a reference resolvable only via appId, a
 * well-known Microsoft id, a GUID nested inside an array, and a genuine
 * dangling reference. A analyser that miscounts any one of these produces a
 * different total, so each case can actually fail the run.
 */

import { strict as assert } from 'node:assert';
import { analyseReferences, naturalKey } from './references.mjs';

const USER_A = '11111111-1111-1111-1111-111111111111';
const GROUP_B = '22222222-2222-2222-2222-222222222222';
const SP_OBJECT = '33333333-3333-3333-3333-333333333333';
const SP_APPID = '44444444-4444-4444-4444-444444444444';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const DANGLING = '99999999-9999-9999-9999-999999999999';
const GRAPH_APPID = '00000003-0000-0000-c000-000000000000';

const collected = new Map([
  ['user', [{ id: USER_A, userPrincipalName: 'ana@contoso.com' }]],
  ['group', [{ id: GROUP_B, mailNickname: 'break-glass', displayName: 'Break Glass' }]],
  ['servicePrincipal', [{ id: SP_OBJECT, appId: SP_APPID, displayName: 'Payroll App' }]],
  [
    'conditionalAccessPolicy',
    [
      {
        id: POLICY_ID, // self-reference: must not be counted
        displayName: 'Require MFA',
        conditions: {
          users: {
            includeUsers: [USER_A], // resolvable, nested in an array
            excludeGroups: [GROUP_B], // resolvable
            excludeUsers: [DANGLING], // unresolvable — a deleted principal
          },
          applications: {
            includeApplications: [GRAPH_APPID, SP_APPID], // well-known + resolvable-via-appId
          },
        },
      },
    ],
  ],
]);

const r = analyseReferences(collected);

// Every object with a GUID id lands in the index; the service principal
// contributes two entries (objectId and appId) because both are referenced.
assert.equal(r.indexedObjects, 5, `indexedObjects: got ${r.indexedObjects}`);

// Identity fields are skipped, never counted as references: user id (1),
// group id (1), service principal id + appId (2), policy id (1).
assert.equal(r.selfReferences, 5, `selfReferences: got ${r.selfReferences}`);
assert.equal(r.totalReferences, 5, `totalReferences: got ${r.totalReferences}`);
assert.equal(r.resolvable, 3, `resolvable: got ${r.resolvable}`); // USER_A, GROUP_B, SP_APPID
assert.equal(r.wellKnown, 1, `wellKnown: got ${r.wellKnown}`); // Microsoft Graph
assert.equal(r.unresolvable, 1, `unresolvable: got ${r.unresolvable}`); // DANGLING

// The unresolvable reference must be attributed to the exact field, because the
// gap report in spec §8.3 tells an operator which setting will not survive.
const [sample] = r.unresolvedSamples;
assert.equal(sample.type, 'conditionalAccessPolicy');
assert.equal(sample.field, 'conditions.users.excludeUsers[0]');
assert.equal(sample.guid, DANGLING);

// Natural keys must be tenant-independent, never the GUID.
assert.equal(naturalKey('user', { id: USER_A, userPrincipalName: 'ana@contoso.com' }), 'ana@contoso.com');
assert.equal(naturalKey('group', { id: GROUP_B, mailNickname: 'break-glass' }), 'break-glass');
assert.equal(naturalKey('servicePrincipal', { id: SP_OBJECT, appId: SP_APPID }), SP_APPID);

console.log('references.test.mjs — all assertions passed');
