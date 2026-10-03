// engine/authz/permissions.mjs
//
// The role -> capability matrix (§3.2), as code rather than rows in the database, so the
// whole matrix is auditable in one place and assertable by a test. Deny by default: a
// role not listed here grants nothing, and nothing is granted except through a role.
export const ROLE_CAPABILITIES = Object.freeze({
  viewer: Object.freeze(['read']),
  operator: Object.freeze(['collect', 'backup', 'baseline-create', 'dispose-accept']),
  approver: Object.freeze(['approve']),
  investigator: Object.freeze(['investigate']),
  restorer: Object.freeze(['restore', 'remediate', 'rollback']),
  admin: Object.freeze(['users', 'roles', 'policies', 'configuration']),
});

export function capabilitiesForRole(role) {
  return ROLE_CAPABILITIES[role] ?? [];
}

// Task 90: every role grant carries a scope. `*` is the central (tenant-wide) scope,
// which every grant made before task 90 already holds through the column default.
// `entity:CODE` confines the grant's capabilities to resources whose current,
// unexpired ownership evidence (task 89) names that entity. Anything else is
// malformed and grants nothing, never a wider scope.
export const CENTRAL_SCOPE = '*';
const ENTITY_SCOPE = /^entity:([A-Z][A-Z0-9_]{1,31})$/;

export function parseGrantScope(scope) {
  if (scope === CENTRAL_SCOPE) return { kind: 'central' };
  const match = typeof scope === 'string' ? ENTITY_SCOPE.exec(scope) : null;
  return match ? { kind: 'entity', entityCode: match[1] } : null;
}

export function entityGrantScope(entityCode) {
  const scope = `entity:${entityCode}`;
  if (!ENTITY_SCOPE.test(scope)) throw new RangeError(`invalid entity code ${entityCode}`);
  return scope;
}
