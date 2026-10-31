// "Restore proven" has one definition (portal audit 31 Oct 2026, metric 5): proven
// means a live test restore on this tenant worked, tested means only the fixture tests
// pass, and the denominator is every kind Keel can put back.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canRestore, provenAt, restoreProof, restoreProofSummary, RESTORE_PROVEN_HREF } from './restoreProof.mjs';
import { protectionHeadline } from './protectionHeadline.mjs';

const at = '2026-10-02T09:00:00.000Z';
const liveAt = '2026-10-20T08:00:00.000Z';
const op = (claim, live) => ({ claim, liveRecord: live === undefined ? null : { live, observedAt: liveAt } });
const writer = (claim, live, decision = 'automated') => ({
  qualification: { decision },
  writeCapability: { operations: { create: op(claim, live), update: op('unsupported') } },
});
const entry = (type, fields = {}) => ({
  type, status: 'covered', stale: false, lastCollectedAt: at, outcome: 'complete', adapter: `graph/${type}`,
  fidelity: { declared: 'read-only', verifiedBy: null }, ...fields,
});

const KINDS = [
  entry('liveWriter', writer('live-qualified', true)),
  entry('lapsedLive', writer('live-qualified', false)),
  entry('drilled', { fidelity: { declared: 'full', verifiedBy: { at, measuredFidelity: 'partial' } } }),
  entry('fixtureWriter', writer('fixture-tested')),
  entry('declaredFull', { fidelity: { declared: 'full', verifiedBy: null } }),
  entry('noWriter', writer('declared')),
  entry('manual', writer('fixture-tested', undefined, 'manual')),
  entry('measuredLow', { ...writer('live-qualified', true), fidelity: { declared: 'full', verifiedBy: { at, measuredFidelity: 'read-only' } } }),
  entry('unprotectable', { ...writer('fixture-tested'), fidelity: { declared: 'unprotectable', verifiedBy: null } }),
  entry('failedBackup', { ...writer('fixture-tested'), status: 'failed', outcome: 'failed' }),
  entry('neverRead', { ...writer('fixture-tested'), status: 'never-collected', outcome: null }),
  entry('noCollector', { status: 'not-covered', adapter: null, fidelity: { declared: 'full', verifiedBy: null } }),
  entry('notOnTenant', { ...writer('fixture-tested'), status: 'failed', outcome: 'unavailable' }),
];
const proofOf = (type) => restoreProof(KINDS.find((kind) => kind.type === type));

test('each kind is proven, tested, untested or cannot be put back', () => {
  assert.equal(proofOf('liveWriter'), 'proven', 'a write that ran live on the tenant proves the restore');
  assert.equal(proofOf('drilled'), 'proven', 'a drill that measured partial fidelity proves it');
  assert.equal(proofOf('lapsedLive'), 'tested', 'a live record that no longer counts proves nothing; the writer is still tested');
  assert.equal(proofOf('fixtureWriter'), 'tested');
  assert.equal(proofOf('failedBackup'), 'tested', 'a failed last backup does not change whether Keel can put it back');
  assert.equal(proofOf('declaredFull'), 'untested');
  for (const type of ['noWriter', 'manual', 'measuredLow', 'unprotectable', 'neverRead', 'noCollector', 'notOnTenant']) {
    assert.equal(proofOf(type), 'none', type);
    assert.equal(canRestore(KINDS.find((kind) => kind.type === type)), false, type);
  }
});

test('the summary counts the kinds Keel can put back, and when a restore was last proven', () => {
  assert.deepEqual(restoreProofSummary(KINDS), {
    restorable: 6, proven: 2, tested: 3, untested: 1, lastProvenAt: liveAt, href: RESTORE_PROVEN_HREF,
  });
  assert.equal(RESTORE_PROVEN_HREF, '/protect?health=proven');
  assert.equal(provenAt(KINDS[2]), at);
  assert.equal(provenAt(KINDS[3]), null, 'a kind that is not proven has no proven date');
  assert.deepEqual(restoreProofSummary([]), { restorable: 0, proven: 0, tested: 0, untested: 0, lastProvenAt: null, href: RESTORE_PROVEN_HREF });
});

test("the portal's normalised kind counts the same as the engine entry", () => {
  const normalised = KINDS.map(({ status, fidelity, ...rest }) => ({
    ...rest,
    reportStatus: status,
    fidelity: { declared: fidelity.declared, measured: fidelity.verifiedBy?.measuredFidelity ?? null, verifiedAt: fidelity.verifiedBy?.at ?? null },
  }));
  assert.deepEqual(restoreProofSummary(normalised), restoreProofSummary(KINDS));
});

test('the Overview headline carries the same count, and its last proven restore', () => {
  const headline = protectionHeadline(KINDS);
  assert.deepEqual(headline.proof, restoreProofSummary(KINDS));
  assert.equal(headline.lastProvenRestoreAt, liveAt, 'a live run proves a restore as much as a drill');

  const nothingLive = protectionHeadline([entry('fixtureWriter', writer('fixture-tested'))]);
  assert.equal(nothingLive.state, 'unproven');
  assert.equal(nothingLive.proof.proven, 0);
  assert.equal(nothingLive.proof.tested, 1);
  assert.equal(nothingLive.lastProvenRestoreAt, null);
});

test('a proven kind with no recorded date still makes the headline proven, and an unknown measurement is ignored', () => {
  const undated = entry('undated', writer('live-qualified'));
  const headline = protectionHeadline([undated]);
  assert.equal(headline.proof.proven, 1);
  assert.equal(headline.state, 'proven');
  assert.equal(headline.lastProvenRestoreAt, null);
  assert.doesNotMatch(headline.sentence, /Last proven restore/);

  const odd = entry('odd', { ...writer('fixture-tested'), fidelity: { declared: 'read-only', verifiedBy: { at, measuredFidelity: 'none' } } });
  assert.equal(restoreProof(odd), 'tested', 'an unknown measured value falls back to the declared rule, as the portal does');
});
