import { strict as assert } from 'node:assert';
import { assertBreakGlassCoverage } from './breakGlassInvariant.mjs';

const bg = ['bg-user-1', 'bg-user-2'];
const covered = [{ naturalKey: 'ca:X', conditions: { users: { excludeUsers: ['bg-user-1', 'bg-user-2'] } } }];
const missingOne = [{ naturalKey: 'ca:Y', conditions: { users: { excludeUsers: ['bg-user-1'] } } }];

assert.equal(assertBreakGlassCoverage({ breakGlassUserIds: bg, caPoliciesInRestoreSet: covered }).ok, true);

const missingResult = assertBreakGlassCoverage({ breakGlassUserIds: bg, caPoliciesInRestoreSet: missingOne });
assert.equal(missingResult.ok, false);
assert.match(missingResult.reason, /bg-user-2/);
assert.match(missingResult.reason, /ca:Y/);

// Fewer than 2 break-glass accounts is a hard fail regardless of CA coverage —
// this is a distinct check from exclusion coverage, tested separately so a fix
// to one branch can't accidentally mask the other.
assert.equal(assertBreakGlassCoverage({ breakGlassUserIds: ['only-one'], caPoliciesInRestoreSet: [] }).ok, false);
assert.equal(assertBreakGlassCoverage({ breakGlassUserIds: [], caPoliciesInRestoreSet: [] }).ok, false);

console.log('breakGlassInvariant.test.mjs — all assertions passed');
