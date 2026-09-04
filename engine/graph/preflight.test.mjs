import { strict as assert } from 'node:assert';
import { buildGapReport, isPlanClean } from './preflight.mjs';


const resources = [{ naturalKey: 'a' }, { naturalKey: 'b' }, { naturalKey: 'c' }];
const unresolvedNone = [];
const cleanReport = buildGapReport({ resources, unresolved: unresolvedNone });
assert.equal(cleanReport.resourcesInPlan, 3);
assert.equal(cleanReport.blocking.length, 0);
assert.equal(isPlanClean(cleanReport), true);


const unresolvedMixed = [
  { naturalKey: 'a', field: 'x', symbol: 'group:Missing', required: true },
  { naturalKey: 'b', field: 'y', symbol: 'group:AlsoOptional', required: false },
];
const dirtyReport = buildGapReport({ resources, unresolved: unresolvedMixed });
assert.equal(dirtyReport.blocking.length, 1);
assert.equal(dirtyReport.optional.length, 1);
assert.equal(isPlanClean(dirtyReport), false);
// The rendered text must actually name the blocking gap — a report an operator
// can't act on isn't a gap report (spec §8.3's whole point).
assert.ok(dirtyReport.text.includes('group:Missing'));
assert.ok(dirtyReport.text.includes('BLOCKING'));


console.log('preflight.test.mjs — all assertions passed');
