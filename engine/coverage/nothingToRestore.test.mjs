// Kinds with nothing to restore (Microsoft or another system owns them) are not gaps.
// They must never be counted or shown as manual on the coverage doc, the Protect page or
// the restore headline. These checks keep them from drifting back.
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { TYPE_GUIDE, renderCoverageDoc } from './coverageDoc.mjs';
import { protectionHeadline } from './protectionHeadline.mjs';
import { NOTHING_TO_RESTORE, TYPE_DECISIONS, buildOperationLedger, qualificationFor } from './qualification.mjs';

const EXPECTED = [
  'contact', 'directoryRole', 'directoryRoleTemplate', 'directorySettingTemplate', 'managedDevice',
  'organization', 'sharedEmailDomain', 'subscribedSku', 'unifiedRoleManagementPolicyAssignment',
];

test('the nothing-to-restore list is exactly the reviewed kinds', () => {
  assert.deepEqual([...NOTHING_TO_RESTORE].sort(), EXPECTED);
});

test('each nothing-to-restore kind has no writer and says so in its qualification', () => {
  const ledger = buildOperationLedger();
  for (const type of NOTHING_TO_RESTORE) {
    const row = ledger.types.find((candidate) => candidate.resourceType === type);
    assert.equal(row.nothingToRestore, true, type);
    assert.ok(row.operations.every((operation) => operation.decision !== 'supported'), `${type} has a writer`);
    assert.equal(qualificationFor(type).nothingToRestore, true, type);
  }
  assert.equal(qualificationFor('group').nothingToRestore, false);
});

test('a Microsoft-managed kind cannot be left as manual, and an automated kind cannot be nothing to restore', () => {
  const asManual = { ...TYPE_DECISIONS, organization: { decision: 'manual', reason: 'tenant object' } };
  assert.throws(() => buildOperationLedger({ decisions: asManual }), /organization is Microsoft-managed, so it must be marked nothing to restore/);
  const automatedNothing = { ...TYPE_DECISIONS, group: { ...TYPE_DECISIONS.group, nothingToRestore: true } };
  assert.throws(() => buildOperationLedger({ decisions: automatedNothing }), /group: nothing to restore, but marked automated/);
});

test('the coverage doc shows them as nothing to restore and leaves them out of the by-hand count', () => {
  const doc = renderCoverageDoc();
  for (const type of NOTHING_TO_RESTORE) {
    const name = TYPE_GUIDE[type].name;
    const row = doc.split('\n').find((line) => line.startsWith(`| ${name} |`));
    assert.ok(row, `${type} has a table row`);
    assert.match(row, /\| Nothing to restore \|/, `${type}: ${row}`);
    assert.ok(doc.includes(`- **${name}** (Nothing to restore).`), `${type} note is labelled nothing to restore`);
  }
  const ledger = buildOperationLedger();
  const automated = ledger.types.filter((row) => row.decision === 'automated').length;
  const manual = ledger.types.length - automated - NOTHING_TO_RESTORE.length;
  assert.ok(doc.includes(`KEEL can restore ${automated} at least in part and ${NOTHING_TO_RESTORE.length} hold nothing to restore; the other ${manual} are restored by hand`));
});

test('the coverage doc refuses guide text that disagrees about nothing to restore', () => {
  const asByHand = { ...TYPE_GUIDE, organization: { ...TYPE_GUIDE.organization, limit: 'microsoft' } };
  assert.throws(() => renderCoverageDoc({ typeGuide: asByHand }), /organization is nothing to restore in TYPE_DECISIONS, but its TYPE_GUIDE text says not so/);
  const asNothing = { ...TYPE_GUIDE, domain: { ...TYPE_GUIDE.domain, limit: 'nothing' } };
  assert.throws(() => renderCoverageDoc({ typeGuide: asNothing }), /domain is not nothing to restore in TYPE_DECISIONS, but its TYPE_GUIDE text says so/);
});

test('the restore headline leaves nothing-to-restore kinds out of "of N"', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const entry = (type, extra = {}) => ({
    type, status: 'covered', stale: false, lastCollectedAt: at,
    fidelity: { declared: 'read-only', verifiedBy: null }, qualification: qualificationFor(type), ...extra,
  });
  const proven = entry('group', { fidelity: { declared: 'full', verifiedBy: { at, measuredFidelity: 'full' } } });
  const headline = protectionHeadline([proven, entry('organization'), entry('subscribedSku'), entry('domain')]);
  assert.equal(headline.counts.backedUp, 4);
  assert.equal(headline.counts.restoreTotal, 2, 'organization and subscribedSku are not restore gaps');
  assert.equal(headline.counts.restorable, 1);
  assert.match(headline.sentence, /^KEEL can restore 1 of 2 configuration types today\./);
});
