import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { snapshotHasFullCoverage, snapshotReadyForDrift, typesSkippedByDrift } from './completions.mjs';

const snap = (coverage_digest, status = 'complete') => ({ status, coverage_digest });

test('issue #447: one failed type holds back full coverage but not drift detection', () => {
  const digest = {
    group: { outcome: 'complete', itemCount: 3 },
    deviceManagementSettings: { outcome: 'failed', itemCount: null, httpStatus: 400 },
    namedLocation: { outcome: 'partial', itemCount: 1 },
    user: { outcome: 'not-requested', itemCount: null },
    lifecycleWorkflow: { outcome: 'unavailable', itemCount: null },
  };
  assert.equal(snapshotHasFullCoverage(snap(digest)), false, 'health still reports the failed type');
  assert.equal(snapshotReadyForDrift(snap(digest)), true);
  assert.deepEqual(typesSkippedByDrift(snap(digest)), ['deviceManagementSettings', 'namedLocation']);
});

test('drift still waits when nothing was read in full or the snapshot did not finish', () => {
  for (const digest of [
    {}, { group: { outcome: 'failed' } }, { group: { outcome: 'partial' } },
    { group: { outcome: 'not-requested' } }, { group: { outcome: 'unavailable' } }, { group: { itemCount: 0 } },
  ]) assert.equal(snapshotReadyForDrift(snap(digest)), false, JSON.stringify(digest));
  assert.equal(snapshotReadyForDrift(snap({ group: { outcome: 'complete' } }, 'running')), false);
  assert.equal(snapshotReadyForDrift(snap(null)), false);
  assert.equal(snapshotReadyForDrift(snap([])), false);
  assert.equal(snapshotReadyForDrift(null), false);
  assert.deepEqual(typesSkippedByDrift(null), []);
});

test('a snapshot read in full is ready for drift and skips nothing', () => {
  const digest = { group: { outcome: 'complete-empty', itemCount: 0 }, user: { outcome: 'not-requested' } };
  assert.equal(snapshotReadyForDrift(snap(digest)), true);
  assert.deepEqual(typesSkippedByDrift(snap(digest)), []);
});
