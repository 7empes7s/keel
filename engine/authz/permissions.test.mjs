import { strict as assert } from 'node:assert';
import { CAPABILITIES, ROLE_CAPABILITIES, capabilitiesForRole } from './permissions.mjs';

// --- the matrix contains exactly the documented roles (§3.2, plus task-71's investigator) ---
assert.deepEqual(Object.keys(ROLE_CAPABILITIES).sort(), [
  'admin', 'approver', 'investigator', 'operator', 'restorer', 'viewer',
]);

// --- every capability, including the Wave 2 names ---
assert.deepEqual([...CAPABILITIES], [
  'approve', 'automation', 'backup', 'baseline-create', 'collect', 'configuration', 'content-backup',
  'content-restore', 'discover', 'dispose-accept', 'export', 'investigate', 'policies', 'read', 'remediate',
  'restore', 'roles', 'rollback', 'template-apply', 'users',
]);

// --- the full matrix: every role against every capability, granted or not ---
const EXPECTED = {
  viewer: ['read'],
  operator: ['backup', 'baseline-create', 'collect', 'content-backup', 'discover', 'dispose-accept', 'export'],
  approver: ['approve'],
  investigator: ['investigate'],
  restorer: ['content-restore', 'remediate', 'restore', 'rollback', 'template-apply'],
  admin: ['automation', 'configuration', 'policies', 'roles', 'users'],
};
for (const role of Object.keys(ROLE_CAPABILITIES)) {
  for (const capability of CAPABILITIES) {
    assert.equal(
      capabilitiesForRole(role).includes(capability),
      EXPECTED[role].includes(capability),
      `${role} ${EXPECTED[role].includes(capability) ? 'must' : 'must not'} grant ${capability}`,
    );
  }
}

// --- every capability is granted by exactly one role (no role overlaps another) ---
for (const capability of CAPABILITIES) {
  const roles = Object.keys(ROLE_CAPABILITIES).filter((role) => ROLE_CAPABILITIES[role].includes(capability));
  assert.equal(roles.length, 1, `${capability} is granted by ${roles.join(', ')}`);
}

// --- an unknown role grants nothing ---
assert.deepEqual(capabilitiesForRole('no-such-role'), []);
assert.deepEqual(capabilitiesForRole(''), []);
assert.deepEqual(capabilitiesForRole(undefined), []);

console.log('permissions.test.mjs — all assertions passed');
