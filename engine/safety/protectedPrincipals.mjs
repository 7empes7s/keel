/**
 * Which canonical roleAssignment resources grant Global Administrator, and so name the
 * principals the sign-in path gate, the deletion guard and the break-glass invariant protect.
 *
 * A roleAssignment's natural key embeds its role as a symbol, and the symbol depends on what was
 * collected alongside it (engine/cir/canonicalize.mjs): `global:GlobalAdministrator` when the role
 * definitions were not in the batch, `roleDefinition:<template id>` when they were. Matching the
 * display text alone misses the second form, which is what a live collection produces, and leaves
 * the protected list empty. Match the role by its template id instead, in the key or the payload.
 */

export const GLOBAL_ADMINISTRATOR_TEMPLATE_ID = '62e90394-69f5-4237-9190-012177145e10';

const GLOBAL_SYMBOL = 'global:GlobalAdministrator';

function roleSymbolOf(naturalKey) {
  // roleAssignment:<role symbol>@<principal symbol>@<scope>
  const body = naturalKey.startsWith('roleAssignment:') ? naturalKey.slice('roleAssignment:'.length) : naturalKey;
  const at = body.indexOf('@');
  return at === -1 ? body : body.slice(0, at);
}

export function isGlobalAdministratorAssignment(resource) {
  if (resource?.resourceType !== 'roleAssignment') return false;
  const roleDefinitionId = resource.payload?.roleDefinitionId;
  if (typeof roleDefinitionId === 'string' && roleDefinitionId.toLowerCase() === GLOBAL_ADMINISTRATOR_TEMPLATE_ID) return true;
  const naturalKey = typeof resource.naturalKey === 'string' ? resource.naturalKey : '';
  const role = roleSymbolOf(naturalKey).toLowerCase();
  return role === GLOBAL_SYMBOL.toLowerCase()
    || role === `roledefinition:${GLOBAL_ADMINISTRATOR_TEMPLATE_ID}`
    // Older fixtures and keys spell the role as plain display text (roleAssignment:GlobalAdministrator:…).
    || role.split(':').includes('globaladministrator');
}

/** Principal ids holding Global Administrator, in input order, without duplicates or blanks. */
export function globalAdministratorPrincipalIds(resources) {
  const ids = [];
  for (const resource of resources ?? []) {
    if (!isGlobalAdministratorAssignment(resource)) continue;
    const id = resource.payload?.principalId;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
