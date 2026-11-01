// The memorable number counts restorable and failing types by the Protect page's
// rules (#336): a tested writer makes a declared read-only type restorable, and a
// type the tenant has no licence or feature for is not a failed backup.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { hasRestoreWriter, protectionHeadline } from './protectionHeadline.mjs';

const at = '2026-10-02T09:00:00.000Z';
const writer = (claim, decision = 'automated') => ({
  qualification: { decision },
  writeCapability: { operations: { create: { claim }, update: { claim: 'unsupported' } } },
});
const entry = (type, fields = {}) => ({
  type, status: 'covered', stale: false, lastCollectedAt: at, outcome: 'complete',
  fidelity: { declared: 'read-only', verifiedBy: null }, ...fields,
});
const drilled = { verifiedBy: { at, measuredFidelity: 'full' } };

test('a tested writer, not the declared fidelity, makes a read-only type restorable', () => {
  assert.equal(hasRestoreWriter(writer('fixture-tested')), true);
  assert.equal(hasRestoreWriter(writer('live-qualified')), true);
  assert.equal(hasRestoreWriter(writer('declared-only')), false, 'an untested write is not a writer');
  assert.equal(hasRestoreWriter(writer('fixture-tested', 'manual')), false, 'a manual recovery decision is not a writer');
  assert.equal(hasRestoreWriter({ qualification: { decision: 'automated' }, writeCapability: null }), false);

  const headline = protectionHeadline([
    entry('withWriter', writer('fixture-tested')),
    entry('provenLive', writer('live-qualified')),
    entry('noWriter', writer('declared-only')),
    entry('manual', writer('fixture-tested', 'manual')),
    entry('declaredFull', { fidelity: { declared: 'full', verifiedBy: null } }),
    entry('unprotectable', { ...writer('fixture-tested'), fidelity: { declared: 'unprotectable', verifiedBy: null } }),
    entry('measuredLow', { ...writer('fixture-tested'), fidelity: { declared: 'read-only', verifiedBy: { at, measuredFidelity: 'read-only' } } }),
    entry('drilled', { fidelity: { declared: 'full', ...drilled } }),
  ]);
  assert.equal(headline.state, 'proven');
  assert.equal(headline.counts.backedUp, 8);
  // withWriter, provenLive, declaredFull, drilled. A measured fidelity overrides the writer.
  assert.equal(headline.counts.restorable, 4);
  assert.match(headline.sentence, /^KEEL can restore 4 of 8 configuration types today\./);
});

test('a type unavailable on the tenant is neither failing nor backed up', () => {
  const unavailable = entry('lifecycleWorkflow', { status: 'failed', outcome: 'unavailable' });
  const healthy = [entry('group', { fidelity: { declared: 'full', ...drilled } }), unavailable];
  const headline = protectionHeadline(healthy);
  assert.equal(headline.state, 'proven');
  assert.deepEqual([headline.counts.failing, headline.counts.failed, headline.counts.backedUp], [0, 0, 1]);
  assert.equal(headline.sentence, 'KEEL can restore 1 of 1 configuration type today. Last proven restore: 2 Oct 2026.');

  // A real failure beside it is still counted, alone.
  const failing = protectionHeadline([...healthy, entry('roleAssignment', { status: 'failed', outcome: 'failed' })]);
  assert.equal(failing.state, 'collection');
  assert.equal(failing.counts.failed, 1);
  assert.equal(failing.sentence, '1 configuration type failed its last backup.');
});

// Decision 31 Oct 2026: a partly done read is its own count, never a failure, but it
// still needs attention and is never counted as backed up.
test('a partly done type is its own count, not failed and not backed up', () => {
  const only = protectionHeadline([
    entry('ok', { fidelity: { declared: 'full', verifiedBy: null } }),
    entry('partOne', { status: 'partial', outcome: 'partial' }),
    entry('partTwo', { status: 'partial', outcome: 'partial' }),
  ]);
  assert.deepEqual([only.counts.failed, only.counts.partial, only.counts.failing, only.counts.backedUp], [0, 2, 2, 1]);
  assert.equal(only.state, 'collection');
  assert.equal(only.tone, 'attention');
  assert.equal(only.sentence, '2 configuration types were only partly backed up last time.');

  const mixed = protectionHeadline([
    entry('ok'),
    entry('broken', { status: 'failed', outcome: 'failed' }),
    entry('part', { status: 'partial', outcome: 'partial' }),
  ]);
  assert.deepEqual([mixed.counts.failed, mixed.counts.partial, mixed.counts.failing], [1, 1, 2]);
  assert.equal(mixed.sentence, '2 configuration types have no complete, current backup; the last backup failed for 1 and was only partly done for 1 of them.');
});
