import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PSEUDONYM_CHECK_FROM, assertPseudonymized } from './committedEvidence.mjs';
import { pseudonymizer } from '../../tools/qualification/pseudonymize.mjs';

const RAW_ID = '0d7c2a51-3b8e-4f6a-9c21-5e4b7a8d9f10';
const after = new Date(Date.parse(PSEUDONYM_CHECK_FROM) + 60_000).toISOString();
const before = new Date(Date.parse(PSEUDONYM_CHECK_FROM) - 60_000).toISOString();

test('a committed record captured from the check date on must hold pseudonyms only', () => {
  const text = JSON.stringify({ objectId: RAW_ID });
  assert.throws(() => assertPseudonymized(text, { observedAt: after, label: 'gate: the record' }), /1 id\(s\) that are not pseudonyms/);
  // A record with no capture time is checked too.
  assert.throws(() => assertPseudonymized(text, { observedAt: undefined, label: 'gate: the record' }), /not pseudonyms/);
  const safe = JSON.stringify({ objectId: pseudonymizer('sha256:0123456789abcdef').guid(RAW_ID) });
  assert.doesNotThrow(() => assertPseudonymized(safe, { observedAt: after, label: 'gate: the record' }));
});

test('an older signed record is left to its queued recapture', () => {
  assert.doesNotThrow(() => assertPseudonymized(JSON.stringify({ objectId: RAW_ID }), { observedAt: before, label: 'gate: the record' }));
});
