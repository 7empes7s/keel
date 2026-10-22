import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  changeBlastRadius, conditionalAccessBlastRadius, gateBlastRadius, itemBlastRadius, strictestBlastRadius,
} from './blastRadius.mjs';
import { diffSnapshots } from '../govern/diffSnapshots.mjs';
import { exceedsMaxBlastRadius, maxOperationImpact } from '../policy/evaluate.mjs';

const SHAREPOINT = '00000003-0000-0ff1-ce00-000000000000';
const EXCHANGE = '00000002-0000-0ff1-ce00-000000000000';
const ADMIN_ROLE = '62e90394-69f5-4237-9190-012177145e10';

function policy({ state = 'enabled', users = { includeUsers: ['All'] }, apps = ['All'], grant = null, session = null, applications = {} } = {}) {
  return {
    displayName: 'KEEL-RT-rule',
    state,
    conditions: { users, applications: { includeApplications: apps, ...applications }, clientAppTypes: ['all'] },
    grantControls: grant,
    sessionControls: session,
  };
}
const block = { operator: 'OR', builtInControls: ['block'] };
const mfa = { operator: 'OR', builtInControls: ['mfa'] };
const appEnforced = { applicationEnforcedRestrictions: { isEnabled: true }, cloudAppSecurity: null, signInFrequency: null, persistentBrowser: null, disableResilienceDefaults: null };

test('block or grant on all users and all apps is lockout', () => {
  assert.equal(conditionalAccessBlastRadius(policy({ grant: block })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ grant: mfa })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ grant: { authenticationStrength: { id: '00000000-0000-0000-0000-000000000002' } } })), 'tenant-lockout');
});

test('exclusions do not lower a lockout rule: they are not proven to be the emergency accounts', () => {
  const users = { includeUsers: ['All'], excludeUsers: ['11111111-1111-1111-1111-111111111111'], excludeGroups: ['22222222-2222-2222-2222-222222222222'] };
  assert.equal(conditionalAccessBlastRadius(policy({ users, grant: block })), 'tenant-lockout');
});

test('a rule on all apps for one group, or on admin roles for one app, is still lockout', () => {
  assert.equal(conditionalAccessBlastRadius(policy({ users: { includeGroups: ['g1'] }, grant: mfa })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ users: { includeRoles: [ADMIN_ROLE] }, apps: [SHAREPOINT], grant: mfa })), 'tenant-lockout');
});

test('admin ways in count as all apps', () => {
  for (const app of ['Office365', 'MicrosoftAdminPortals', '797f4846-ba00-4fd7-ba43-dac1f8f63013', '00000003-0000-0000-c000-000000000000']) {
    assert.equal(conditionalAccessBlastRadius(policy({ apps: [SHAREPOINT, app], grant: block })), 'tenant-lockout', app);
  }
  assert.equal(conditionalAccessBlastRadius(policy({ apps: [], applications: { includeUserActions: ['urn:user:registersecurityinfo'] }, grant: mfa })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ apps: [], applications: { includeAuthenticationContextClassReferences: ['c1'] }, grant: mfa })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ apps: [SHAREPOINT], applications: { applicationFilter: { mode: 'include', rule: 'x' } }, grant: mfa })), 'tenant-lockout');
});

test('the SharePoint unmanaged-device rules affect access', () => {
  const browser = policy({ apps: [SHAREPOINT], session: appEnforced });
  browser.displayName = '[SharePoint admin center]Use app-enforced Restrictions for browser access';
  assert.equal(conditionalAccessBlastRadius(browser), 'access-affecting');
  const apps = policy({ apps: [SHAREPOINT, EXCHANGE], grant: { operator: 'OR', builtInControls: ['compliantDevice', 'domainJoinedDevice'] } });
  assert.equal(conditionalAccessBlastRadius(apps), 'access-affecting');
});

test('session controls beyond named apps keep lockout', () => {
  assert.equal(conditionalAccessBlastRadius(policy({ session: { signInFrequency: { isEnabled: true, value: 1, type: 'hours' } } })), 'tenant-lockout');
});

test('disabled and report-only rules are one step lower', () => {
  for (const state of ['disabled', 'enabledForReportingButNotEnforced']) {
    assert.equal(conditionalAccessBlastRadius(policy({ state, grant: block })), 'access-affecting', state);
    assert.equal(conditionalAccessBlastRadius(policy({ state, apps: [SHAREPOINT], session: appEnforced })), 'cosmetic', state);
  }
});

test('an unreadable rule keeps lockout', () => {
  assert.equal(conditionalAccessBlastRadius(null), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius({ state: 'disabled' }), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius({ state: 'enabled', conditions: {} }), 'tenant-lockout');
  // No readable controls at all: unsure, so the higher rating.
  assert.equal(conditionalAccessBlastRadius(policy({ apps: [SHAREPOINT] })), 'tenant-lockout');
  assert.equal(conditionalAccessBlastRadius(policy({ apps: [SHAREPOINT], session: { applicationEnforcedRestrictions: { isEnabled: false } } })), 'tenant-lockout');
});

test('other types keep their stored rating', () => {
  assert.equal(itemBlastRadius('group', { displayName: 'x' }, 'access-affecting'), 'access-affecting');
  assert.equal(itemBlastRadius('conditionalAccessPolicy', null, 'tenant-lockout'), 'tenant-lockout');
  assert.equal(changeBlastRadius('namedLocation', null, null, 'tenant-lockout'), 'tenant-lockout');
});

test('a change takes the stricter side', () => {
  const sharepoint = policy({ apps: [SHAREPOINT], session: appEnforced });
  const wide = policy({ grant: block });
  assert.equal(changeBlastRadius('conditionalAccessPolicy', sharepoint, sharepoint, 'tenant-lockout'), 'access-affecting');
  assert.equal(changeBlastRadius('conditionalAccessPolicy', wide, { ...wide, state: 'disabled' }, 'tenant-lockout'), 'tenant-lockout');
  assert.equal(changeBlastRadius('conditionalAccessPolicy', { ...wide, state: 'disabled' }, wide, 'tenant-lockout'), 'tenant-lockout');
  assert.equal(changeBlastRadius('conditionalAccessPolicy', null, { ...sharepoint, state: 'disabled' }, 'tenant-lockout'), 'cosmetic');
  assert.equal(strictestBlastRadius('cosmetic', 'made-up', 'tenant-lockout'), 'made-up');
});

test('changes found by drift detection carry the per-rule rating', () => {
  const sharepoint = policy({ apps: [SHAREPOINT], session: appEnforced });
  const row = (key, payload, hash) => ({ natural_key: key, resource_type: 'conditionalAccessPolicy', payload, payload_hash: hash, hash_version: 1, blast_radius: 'tenant-lockout' });
  const drift = diffSnapshots(
    [row('ca:sp', sharepoint, 'a'), row('ca:gone', { ...sharepoint, state: 'disabled' }, 'b'), row('ca:wide', policy({ grant: block }), 'c')],
    [row('ca:sp', { ...sharepoint, displayName: 'renamed' }, 'a2'), row('ca:wide', { ...policy({ grant: block }), state: 'disabled' }, 'c2')],
  );
  const byKey = Object.fromEntries(drift.map((item) => [item.naturalKey, item.blastRadius]));
  assert.deepEqual(byKey, { 'ca:sp': 'access-affecting', 'ca:gone': 'cosmetic', 'ca:wide': 'tenant-lockout' });
});

test('safety gates keep the type rating as a floor', () => {
  assert.equal(gateBlastRadius('conditionalAccessPolicy', 'cosmetic'), 'tenant-lockout');
  assert.equal(gateBlastRadius('conditionalAccessPolicy', null), 'tenant-lockout');
  assert.equal(gateBlastRadius('group', 'access-affecting'), 'access-affecting');
  const drift = { resource_type: 'conditionalAccessPolicy', blast_radius: 'access-affecting' };
  assert.equal(exceedsMaxBlastRadius(drift, { max_blast_radius: 'access-affecting' }), true);
  const { maxBlastRadius } = maxOperationImpact([{ naturalKey: 'ca:sp', resourceType: 'conditionalAccessPolicy', verb: 'update', blastRadius: 'cosmetic' }]);
  assert.equal(maxBlastRadius, 'tenant-lockout');
});
