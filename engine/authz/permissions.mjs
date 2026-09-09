// engine/authz/permissions.mjs
//
// The role -> capability matrix (§3.2), as code rather than rows in the database, so the
// whole matrix is auditable in one place and assertable by a test. Deny by default: a
// role not listed here grants nothing, and nothing is granted except through a role.
export const ROLE_CAPABILITIES = Object.freeze({
  viewer: Object.freeze(['read']),
  operator: Object.freeze(['collect', 'backup', 'baseline-create', 'dispose-accept']),
  approver: Object.freeze(['approve']),
  restorer: Object.freeze(['restore', 'remediate', 'rollback']),
  admin: Object.freeze(['users', 'roles', 'policies', 'configuration']),
});

export function capabilitiesForRole(role) {
  return ROLE_CAPABILITIES[role] ?? [];
}
