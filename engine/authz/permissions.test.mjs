import { strict as assert } from 'node:assert';
import { ROLE_CAPABILITIES, capabilitiesForRole } from './permissions.mjs';

// --- the matrix contains exactly the five documented roles (§3.2) ---
assert.deepEqual(Object.keys(ROLE_CAPABILITIES).sort(), [
  'admin', 'approver', 'operator', 'restorer', 'viewer',
]);

// --- each role grants exactly its documented capabilities and no others ---
assert.deepEqual([...ROLE_CAPABILITIES.viewer].sort(), ['read']);
assert.deepEqual([...ROLE_CAPABILITIES.operator].sort(), [
  'backup', 'baseline-create', 'collect', 'dispose-accept',
]);
assert.deepEqual([...ROLE_CAPABILITIES.approver].sort(), ['approve']);
assert.deepEqual([...ROLE_CAPABILITIES.restorer].sort(), [
  'remediate', 'restore', 'rollback',
]);
assert.deepEqual([...ROLE_CAPABILITIES.admin].sort(), [
  'configuration', 'policies', 'roles', 'users',
]);

// --- an unknown role grants nothing ---
assert.deepEqual(capabilitiesForRole('no-such-role'), []);
assert.deepEqual(capabilitiesForRole(''), []);
assert.deepEqual(capabilitiesForRole(undefined), []);

console.log('permissions.test.mjs — all assertions passed');
