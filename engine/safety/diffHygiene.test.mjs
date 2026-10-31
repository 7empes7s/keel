import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HIDDEN, diffNormal, isCredentialField, isEmptyValue, maskCredentials, sameForDiff } from './diffHygiene.mjs';

test('empty values read the same: null, missing, "" and empty lists or objects', () => {
  for (const value of [null, undefined, '', [], {}, [null, ''], { a: null, b: '' }]) assert.equal(isEmptyValue(value), true, JSON.stringify(value));
  assert.equal(sameForDiff(null, ''), true);
  assert.equal(sameForDiff({ description: null }, { description: '' }), true);
  assert.equal(sameForDiff({ description: null, state: 'on' }, { state: 'on' }), true);
  for (const value of [0, false, 'x', [0], { a: false }]) assert.equal(isEmptyValue(value), false, JSON.stringify(value));
});

test('lists compare as sets: order alone is no difference', () => {
  assert.equal(sameForDiff(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameForDiff([{ keyId: '1', hint: 'U4i' }, { keyId: '2', hint: '68t' }], [{ hint: '68t', keyId: '2' }, { keyId: '1', hint: 'U4i' }]), true);
  assert.equal(sameForDiff(['a', 'b'], ['a', 'c']), false);
  assert.equal(sameForDiff(['a'], ['a', 'a']), false);
  assert.deepEqual(diffNormal({ b: [2, 1], a: '' }), { b: [1, 2] });
});

test('credential values are hidden wherever they sit, other values are kept', () => {
  const payload = {
    displayName: 'KEEL-RT- app',
    passwordCredentials: [{ keyId: 'k1', hint: 'U4i', displayName: 'ci' }, { keyId: 'k2', hint: '68t', secretText: null }],
    passwordProfile: { password: 'Secret!1', forceChangePasswordNextSignIn: true },
    passwordRequired: true,
  };
  assert.deepEqual(maskCredentials(payload), {
    displayName: 'KEEL-RT- app',
    passwordCredentials: [{ keyId: 'k1', hint: HIDDEN, displayName: 'ci' }, { keyId: 'k2', hint: HIDDEN, secretText: null }],
    passwordProfile: { password: HIDDEN, forceChangePasswordNextSignIn: true },
    passwordRequired: true,
  });
  assert.equal(JSON.stringify(maskCredentials(payload)).includes('U4i'), false);
  // A lone value under a credential path is hidden too.
  assert.equal(maskCredentials('U4i', 'passwordCredentials.hint'), HIDDEN);
  assert.equal(maskCredentials('U4i', 'displayName'), 'U4i');
  assert.equal(isCredentialField('passwordPolicies'), false);
  assert.equal(isCredentialField('wifi.preSharedKey'), true);
});

test('Changes, Compare and Activity diffs (semanticChange) skip no-op differences and hide hints', async () => {
  const { semanticChange } = await import('../govern/semanticDrift.mjs');
  const before = {
    displayName: 'KEEL-RT- app', description: null, tags: ['b', 'a'],
    passwordCredentials: [{ keyId: '11111111-1111-1111-1111-111111111111', hint: 'U4i', displayName: 'one' }],
  };
  const after = {
    displayName: 'KEEL-RT- app', description: '', tags: ['a', 'b'], notes: '',
    passwordCredentials: [
      { keyId: '11111111-1111-1111-1111-111111111111', hint: 'U4i', displayName: 'one' },
      { keyId: '22222222-2222-2222-2222-222222222222', hint: '68t', displayName: 'two' },
    ],
  };
  const change = semanticChange({ resourceType: 'application', changeType: 'modified', before, after });
  assert.deepEqual(change.fields.map((field) => field.path), ['passwordCredentials']);
  assert.equal(change.ignored, 3);
  const text = JSON.stringify({ fields: change.fields, projected: change.projected });
  assert.equal(text.includes('U4i') || text.includes('68t'), false);
  assert.ok(text.includes(HIDDEN));

  const reordered = semanticChange({ resourceType: 'application', changeType: 'modified', before: { tags: ['a', 'b'], description: null }, after: { tags: ['b', 'a'], description: '' } });
  assert.equal(reordered.total, 0);
});
