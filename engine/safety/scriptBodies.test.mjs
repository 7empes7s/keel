// PR #435 follow-up: an Intune script's text never reaches a read view, and a
// restore that puts it back on devices needs a second person's approval.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { semanticChange } from '../govern/semanticDrift.mjs';
import { compareSettings } from '../govern/compare.mjs';
import { classifyContentEffects, contentEffectsDigest } from './contentEffects.mjs';
import { SCRIPT_BODY_FIELDS, scriptSummary, scriptText, withoutScriptBodies } from './scriptBodies.mjs';

const SECRET = '$password = "KEEL-RT-not-a-real-secret"';
const encoded = (text) => Buffer.from(text, 'utf8').toString('base64');

test('every script body field is replaced by its size and a fingerprint', () => {
  for (const [resourceType, fields] of Object.entries(SCRIPT_BODY_FIELDS)) {
    const payload = { id: 's-1', displayName: 'KEEL-RT-script', ...Object.fromEntries(fields.map((field) => [field, encoded(SECRET)])) };
    const hidden = withoutScriptBodies(resourceType, payload);
    for (const field of fields) {
      assert.match(hidden[field], /^Script text hidden \(\d+ characters, fingerprint [0-9a-f]{12}\)$/, `${resourceType}.${field}`);
      assert.ok(!JSON.stringify(hidden).includes(encoded(SECRET)));
      assert.ok(!JSON.stringify(hidden).includes('not-a-real-secret'));
    }
    assert.equal(hidden.displayName, 'KEEL-RT-script');
    assert.equal(payload[fields[0]], encoded(SECRET), 'the stored payload is not changed');
  }
  const other = { displayName: 'x', scriptContent: 'kept' };
  assert.equal(withoutScriptBodies('deviceConfiguration', other), other);
  assert.equal(withoutScriptBodies('deviceManagementScript', null), null);
});

test('script text is read from base64, and plain text is left as it is', () => {
  assert.equal(scriptText(encoded(SECRET)), SECRET);
  assert.equal(scriptText('not base64!'), 'not base64!');
  assert.equal(scriptSummary(encoded('abc')), scriptSummary(encoded('abc')));
  assert.notEqual(scriptSummary(encoded('abc')), scriptSummary(encoded('abd')));
});

test('a changed script still reads as changed in a diff, without its text', () => {
  const before = { displayName: 'KEEL-RT-script', scriptContent: encoded('Write-Output 1') };
  const after = { displayName: 'KEEL-RT-script', scriptContent: encoded(SECRET) };
  const change = semanticChange({ resourceType: 'deviceManagementScript', changeType: 'modified', before, after });
  assert.deepEqual(change.fields.map((field) => field.path), ['scriptContent']);
  const shown = JSON.stringify(change);
  assert.ok(!shown.includes(encoded(SECRET)) && !shown.includes('not-a-real-secret') && !shown.includes(encoded('Write-Output 1')));
  assert.match(change.fields[0].after, /^Script text hidden/);
  const added = semanticChange({ resourceType: 'deviceManagementScript', changeType: 'unknown', before: null, after });
  assert.ok(!JSON.stringify(added).includes(encoded(SECRET)));
});

test('Compare shows a changed or added script without its text', () => {
  const row = (natural_key, payload) => ({ natural_key, resource_type: 'deviceShellScript', payload, payload_hash: JSON.stringify(payload), hash_version: 2, blast_radius: 'low' });
  const left = { rows: [row('deviceShellScript:a', { displayName: 'a', scriptContent: encoded('echo 1') })], coverage: { deviceShellScript: { outcome: 'complete' } } };
  const right = {
    rows: [
      row('deviceShellScript:a', { displayName: 'a', scriptContent: encoded(SECRET) }),
      row('deviceShellScript:b', { displayName: 'b', scriptContent: encoded(SECRET) }),
    ],
    coverage: { deviceShellScript: { outcome: 'complete' } },
  };
  const result = compareSettings(left, right);
  const shown = JSON.stringify(result);
  assert.ok(!shown.includes(encoded(SECRET)) && !shown.includes(encoded('echo 1')));
  const items = result.groups.flatMap((group) => group.items);
  assert.deepEqual(items.map((item) => item.changeType).sort(), ['added', 'changed']);
});

test('putting back a script\'s text on an existing script needs its own approval, bound to exactly that text', () => {
  const live = { id: 's-1', displayName: 'KEEL-RT-script', scriptContent: encoded('echo live') };
  const resource = (text, verb = 'update') => ({
    naturalKey: 'deviceManagementScript:KEEL-RT-script', resourceType: 'deviceManagementScript', verb,
    payload: { ...live, scriptContent: encoded(text) }, live: verb === 'create' ? { state: 'absent' } : { state: 'present', payload: live },
  });
  const { effects, refusals } = classifyContentEffects([resource('echo backup')]);
  assert.deepEqual(refusals, []);
  assert.equal(effects.length, 1);
  const [effect] = effects;
  assert.equal(effect.effect, 'runs-on-devices');
  assert.equal(effect.field, 'scriptContent');
  assert.match(effect.after, /^11 characters, sha256 [0-9a-f]{64}$/);
  assert.deepEqual(effect.script, { before: 'echo live', after: 'echo backup' });
  assert.match(effect.disclosure, /every device the script is assigned to/);
  // Another text is another effect: an approval of one never covers the other.
  const [other] = classifyContentEffects([resource('echo tampered')]).effects;
  assert.notEqual(contentEffectsDigest([effect]), contentEffectsDigest([other]));
  // The same text, and a recreated script the restore does not assign, need nothing (issue #461 covers the assigned one).
  assert.deepEqual(classifyContentEffects([resource('echo live')]).effects, []);
  assert.deepEqual(classifyContentEffects([resource('echo backup', 'create')]).effects, []);
  // A live script whose text was not read counts as different.
  const unread = { ...resource('echo backup'), live: { state: 'present', payload: { id: 's-1', displayName: 'KEEL-RT-script' } } };
  const [blind] = classifyContentEffects([unread]).effects;
  assert.equal(blind.before, null);
  assert.equal(blind.script.before, null);
});
