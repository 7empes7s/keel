/**
 * Issue #1076: how long a soft-deleted object can still be recovered from
 * deleted items, and the purge step for a deleted Conditional Access policy
 * whose recovery window has closed. Fixed times only, never the wall clock.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  RECOVERY_WARNING_DAYS, SOFT_DELETE_RETENTION_DAYS, oldCopyPurgeStep, recoveryWindow,
} from './recoveryMechanism.mjs';

const DELETED = '2026-10-01T10:00:00.000Z';
const DEADLINE = '2026-10-31T10:00:00.000Z';
const at = (iso) => new Date(iso);

test('the deadline is the deleted date plus 30 days', () => {
  assert.equal(SOFT_DELETE_RETENTION_DAYS, 30);
  assert.equal(recoveryWindow({ deletedDateTime: DELETED }, { now: at('2026-10-02T00:00:00Z') }).deadline, DEADLINE);
  // A deadline the plan already worked out is taken as it is.
  assert.equal(recoveryWindow({ deadline: DEADLINE }, { now: at('2026-10-02T00:00:00Z') }).deadline, DEADLINE);
});

test('a window with more than 7 days left is open', () => {
  const window = recoveryWindow({ deletedDateTime: DELETED }, { now: at('2026-10-23T09:59:59Z') });
  assert.equal(window.state, 'open');
  assert.equal(window.daysLeft, 9);
});

test('from 7 days left the window is closing, until the deadline itself', () => {
  assert.equal(RECOVERY_WARNING_DAYS, 7);
  const seven = recoveryWindow({ deletedDateTime: DELETED }, { now: at('2026-10-24T10:00:00Z') });
  assert.deepEqual(seven, { deadline: DEADLINE, daysLeft: 7, state: 'closing' });
  const lastHour = recoveryWindow({ deletedDateTime: DELETED }, { now: at('2026-10-31T09:00:00Z') });
  assert.deepEqual(lastHour, { deadline: DEADLINE, daysLeft: 1, state: 'closing' });
});

test('at and after the deadline the window is expired', () => {
  assert.deepEqual(recoveryWindow({ deletedDateTime: DELETED }, { now: at(DEADLINE) }), { deadline: DEADLINE, daysLeft: 0, state: 'expired' });
  assert.equal(recoveryWindow({ deletedDateTime: DELETED }, { now: at('2026-12-01T00:00:00Z') }).state, 'expired');
});

test('no deleted date, no window', () => {
  assert.equal(recoveryWindow({ deletedDateTime: null }, { now: at(DEADLINE) }), null);
  assert.equal(recoveryWindow({ deletedDateTime: 'not a date' }, { now: at(DEADLINE) }), null);
  assert.equal(recoveryWindow({}, { now: at(DEADLINE) }), null);
});

const deletedPolicy = (deletedDateTime, extra = {}) => ({
  naturalKey: 'conditionalAccessPolicy:Require-MFA-All',
  resourceType: 'conditionalAccessPolicy',
  live: { state: 'soft-deleted', deletedItemId: 'ca-1', payload: { id: 'ca-1', deletedDateTime }, ...extra },
});

test('a deleted policy past its window gets a purge step that says an app cannot purge it', () => {
  const step = oldCopyPurgeStep(deletedPolicy(DELETED), { now: at('2026-11-02T00:00:00Z') });
  assert.equal(step.kind, 'manual-setting');
  assert.equal(step.requirement, 'purgeDeletedPolicy');
  assert.match(step.description, /Entra admin center/);
  assert.match(step.description, /app-only/);
  assert.match(step.description, /recreates/);
});

test('no purge step while the policy can still be restored, or when the copy is unknown', () => {
  assert.equal(oldCopyPurgeStep(deletedPolicy(DELETED), { now: at('2026-10-30T00:00:00Z') }), null);
  // Without a deleted date the copy might still be restorable: never tell anyone to purge it.
  assert.equal(oldCopyPurgeStep(deletedPolicy(null), { now: at('2026-11-02T00:00:00Z') }), null);
  // Two deleted copies share the name: KEEL cannot say which one to purge.
  assert.equal(oldCopyPurgeStep(deletedPolicy(DELETED, { ambiguous: true }), { now: at('2026-11-02T00:00:00Z') }), null);
  // Other types: an app can remove their deleted copies, or Microsoft does.
  assert.equal(oldCopyPurgeStep({ ...deletedPolicy(DELETED), resourceType: 'group', naturalKey: 'group:hr' }, { now: at('2026-11-02T00:00:00Z') }), null);
  assert.equal(oldCopyPurgeStep({ ...deletedPolicy(DELETED), live: { state: 'present', payload: {} } }, { now: at('2026-11-02T00:00:00Z') }), null);
});
