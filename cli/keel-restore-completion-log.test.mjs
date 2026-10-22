import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { completionStepLines } from './keel-restore.mjs';

test('a single completion step logs its description', () => {
  const entry = { naturalKey: 'policy:a', completion: { kind: 'manual-setting', requirement: 'inboundTrust', description: 'Set inbound trust by hand' } };
  assert.deepEqual(completionStepLines(entry), ['completion step: policy:a — Set inbound trust by hand']);
});

test('a list of completion steps logs one line per step, never "undefined"', () => {
  const entry = {
    naturalKey: 'partner:b',
    completion: [
      { kind: 'enforcement', requirement: 'inboundTrust', description: 'Review inbound trust' },
      { kind: 'manual-setting', requirement: 'password', description: 'Set a password' },
    ],
  };
  const lines = completionStepLines(entry);
  assert.deepEqual(lines, [
    'completion step: partner:b — Review inbound trust',
    'completion step: partner:b — Set a password',
  ]);
  assert.ok(lines.every((line) => !line.includes('undefined')));
});

test('a pending approval step wins over the completion step', () => {
  const entry = { naturalKey: 'p:c', pendingApproval: { description: 'Approve the shorter lifetime' }, completion: [{ description: 'other' }] };
  assert.deepEqual(completionStepLines(entry), ['completion step: p:c — Approve the shorter lifetime']);
});

test('no completion step, an empty list or a step without a description logs nothing', () => {
  assert.deepEqual(completionStepLines({ naturalKey: 'x' }), []);
  assert.deepEqual(completionStepLines({ naturalKey: 'x', completion: [] }), []);
  assert.deepEqual(completionStepLines({ naturalKey: 'x', completion: [{ requirement: 'y' }] }), []);
});
