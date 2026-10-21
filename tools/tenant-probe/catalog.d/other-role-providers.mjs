/** Catalogue family: admin roles outside Entra ID and Intune (remaining kinds, batch 5). See ../catalog.mjs for the entry shape. */
// Read-only list reads of the unified role management providers for Exchange
// Online and Microsoft Defender XDR. Each path is in the operator's export of
// what tenant discovery found readable but not backed up (Q104, run 3 of
// 2026-10-21), so the grant each needs is one the Collector already holds.
// All are beta only, a fidelity risk the spec flags.
// No writer is built for any of them yet: the backup is a record to rebuild from.
// None of these objects holds a secret.
// Entitlement management roles are left out: Microsoft defines all of them
// (discovery skips the path), and their assignments are only listed per role or
// per person, which this family does not read yet.
export default [
  // Exchange management roles. Microsoft's built-in roles are listed beside the
  // tenant's own; isBuiltIn tells them apart.
  { type: 'exchangeRoleDefinition', path: '/roleManagement/exchange/roleDefinitions', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'isBuiltIn tells Microsoft roles from custom ones; a custom role names its parent role.' },
  // Who holds which Exchange role, over which scope: role groups, users and apps.
  { type: 'exchangeRoleAssignment', path: '/roleManagement/exchange/roleAssignments', version: 'beta', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'Points to an Exchange role and, for an app, to a custom app scope by id.' },
  // Exchange management scopes that limit which mailboxes an app role reaches.
  { type: 'exchangeCustomAppScope', path: '/roleManagement/exchange/customAppScopes', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A missing scope widens nothing, but an app assignment that names it fails to restore.' },
  // Microsoft Defender XDR roles (unified role-based access control).
  { type: 'defenderRoleDefinition', path: '/roleManagement/defender/roleDefinitions', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'defenderRoleAssignment', path: '/roleManagement/defender/roleAssignments', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'One assignment can name several people and groups, and the data sources it covers.' },
  { type: 'defenderCustomAppScope', path: '/roleManagement/defender/customAppScopes', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
];
