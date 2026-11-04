// Kinds with nothing to restore (Microsoft owns them: completeness state
// "microsoft-managed") are not gaps. They must never be counted or shown as a manual
// restore on the coverage doc or in the restore headline. These checks keep them from
// drifting back (from #760, rebuilt on the completeness records).
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { TYPE_GUIDE, renderCoverageDoc } from './coverageDoc.mjs';
import { protectionHeadline } from './protectionHeadline.mjs';
import { buildOperationLedger, qualificationFor } from './qualification.mjs';
import { nothingToRestore } from './restoreProof.mjs';

const EXPECTED = [
  'deviceManagementTemplate', 'directoryRole', 'directoryRoleTemplate', 'directorySettingTemplate', 'managedDevice',
  'organization', 'sharedEmailDomain', 'subscribedSku', 'unifiedRoleManagementPolicyAssignment',
];

const managed = () => buildOperationLedger().types.filter((row) => row.completeness.state === 'microsoft-managed');

test('the nothing-to-restore kinds are exactly the reviewed Microsoft-managed list', () => {
  assert.deepEqual(managed().map((row) => row.resourceType).sort(), EXPECTED);
});

test('each one has no writer, and its qualification says nothing to restore', () => {
  for (const row of managed()) {
    assert.equal(row.decision, 'manual', row.resourceType);
    assert.ok(row.operations.every((operation) => operation.decision !== 'supported'), `${row.resourceType} has a writer`);
    assert.equal(nothingToRestore({ qualification: qualificationFor(row.resourceType) }), true, row.resourceType);
  }
  assert.equal(nothingToRestore({ qualification: qualificationFor('group') }), false);
  assert.equal(nothingToRestore({ qualification: qualificationFor('domain') }), false, 'a by-hand kind is a manual restore');
  assert.equal(nothingToRestore({ qualification: qualificationFor('contact') }), false, 'synced contacts are restored at their source');
  assert.equal(nothingToRestore({ qualification: { nothingToRestore: true } }), true, 'the portal\'s normalised flag reads the same');
});

test('the coverage doc shows them as nothing to restore and leaves them out of the by-hand count', () => {
  const doc = renderCoverageDoc();
  const rows = managed();
  for (const row of rows) {
    const name = TYPE_GUIDE[row.resourceType].name;
    const line = doc.split('\n').find((candidate) => candidate.startsWith(`| ${name} |`));
    assert.ok(line, `${row.resourceType} has a table row`);
    assert.match(line, /\| Microsoft-managed \| Nothing to restore \|/, `${row.resourceType}: ${line}`);
    assert.ok(doc.includes(`- **${name}** (Nothing to restore).`), `${row.resourceType}: its note is labelled nothing to restore`);
  }
  const ledger = buildOperationLedger();
  const automated = ledger.types.filter((row) => row.decision === 'automated').length;
  const manual = ledger.types.length - automated - rows.length;
  assert.ok(doc.includes(`KEEL can restore ${automated} at least in part and ${rows.length} hold nothing to restore; the other ${manual} are restored by hand`));
});

test('the coverage doc refuses guide text that gives a Microsoft-managed kind another reason', () => {
  const notBuilt = { ...TYPE_GUIDE, sharedEmailDomain: { ...TYPE_GUIDE.sharedEmailDomain, limit: 'not-built' } };
  assert.throws(() => renderCoverageDoc({ typeGuide: notBuilt }), /sharedEmailDomain is Microsoft-managed, but its TYPE_GUIDE text gives 'not-built'/);
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
