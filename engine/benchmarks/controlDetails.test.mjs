/** Every control Keel ships says why it fails: a fail names each object and setting it
 * checked, with the value found and the value wanted, so the Compliance page can show
 * expected against current. A fail with no lines is allowed only as "not set up yet".
 * A new control without a failing example here fails this test. Pure: no database. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NOT_CONFIGURED, listControls, predicateFor } from './registry.mjs';

const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';

// One failing example per shipped control, as the predicate sees its facts.
const FAILING = {
  'keel-custom.role-assignment.admin-count-at-most': Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, roleDefinitionId: GLOBAL_ADMIN })),
  'keel-custom.named-location.no-untrusted-all-countries': [{ displayName: 'KEEL-RT-office', isTrusted: true, includeUnknownCountriesAndRegions: true }],
  'keel-custom.group.role-assignable-not-synced': [{ displayName: 'KEEL-RT-admins', isAssignableToRole: true, onPremisesSyncEnabled: true }],
  'keel-custom.defender-email.anti-phish-spoof-protection': [{ kind: 'antiPhishPolicy', Name: 'KEEL-RT-phish', IsDefault: true, EnableSpoofIntelligence: false, HonorDmarcPolicy: true, EnableUnauthenticatedSender: true }],
  'keel-custom.defender-email.anti-spam-phish-quarantined': [{ kind: 'antiSpamPolicy', Name: 'KEEL-RT-spam', PhishSpamAction: 'MoveToJmf', HighConfidencePhishAction: 'Quarantine', PhishZapEnabled: true }],
  'keel-custom.defender-email.anti-spam-no-allowed-domains': [{ kind: 'antiSpamPolicy', Name: 'KEEL-RT-spam', AllowedSenderDomains: ['example.com'] }],
  'keel-custom.defender-email.malware-file-filter': [{ kind: 'antiMalwarePolicy', Name: 'KEEL-RT-malware', EnableFileFilter: false, ZapEnabled: true }],
  'keel-custom.defender-email.safe-links-email': [{ kind: 'safeLinksPolicy', Name: 'KEEL-RT-links', EnableSafeLinksForEmail: true, ScanUrls: true, AllowClickThrough: true }],
  'keel-custom.conditional-access.block-legacy': [{
    displayName: 'KEEL-RT-legacy', state: 'enabledForReportingButNotEnforced',
    conditions: { clientAppTypes: ['exchangeActiveSync', 'other'], users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
    grantControls: { builtInControls: ['block'] },
  }],
};

const shipped = listControls({ framework: 'keel-custom' });

test('every shipped control has a failing example here', () => {
  assert.deepEqual(shipped.map((control) => control.controlId).sort(), Object.keys(FAILING).sort());
});

for (const control of shipped) {
  test(`${control.controlId}: a fail names what it checked and what misses`, () => {
    const answer = predicateFor(control.predicate.name)(structuredClone(FAILING[control.controlId]), control.predicate.args);
    assert.equal(typeof answer, 'object', 'a fail must return { verdict, details }, not a bare verdict');
    assert.equal(answer.verdict, 'fail');
    assert.notEqual(answer.reason, NOT_CONFIGURED, 'the example must be a setting that exists with the wrong value');
    assert.ok(Array.isArray(answer.details) && answer.details.length > 0, 'a fail must list the settings it checked');
    for (const line of answer.details) {
      assert.equal(typeof line.subject, 'string');
      assert.ok(line.subject.length > 0);
      assert.equal(typeof line.setting, 'string');
      assert.ok('value' in line && 'expected' in line && typeof line.ok === 'boolean');
    }
    assert.ok(answer.details.some((line) => !line.ok), 'a fail must show at least one failing line');
  });
}
