import { strict as assert } from 'node:assert';
import { naturalKeyFor } from './naturalKey.mjs';

// Pass-through cases: everything except roleAssignment defers to tenant-probe's
// naturalKey(), already proven in references.test.mjs.
assert.equal(
  naturalKeyFor('group', { id: 'g1', mailNickname: 'FIN-Admins' }),
  'FIN-Admins',
);
assert.equal(
  naturalKeyFor('namedLocation', { id: 'nl1', displayName: 'Corp-IPs' }),
  'Corp-IPs',
);
assert.equal(
  naturalKeyFor('conditionalAccessPolicy', { id: 'ca1', displayName: 'Require-MFA-Admins' }),
  'Require-MFA-Admins',
);

// roleAssignment: composite key from role + principal + scope, each resolved via ctx.
const ctx = {
  resolveSymbol: (id) =>
    ({
      'role-guid-1': 'global:GlobalAdministrator',
      'principal-guid-1': 'group:FIN-Admins',
    })[id] ?? null,
};
assert.equal(
  naturalKeyFor(
    'roleAssignment',
    { roleDefinitionId: 'role-guid-1', principalId: 'principal-guid-1', directoryScopeId: '/' },
    ctx,
  ),
  'roleAssignment:global:GlobalAdministrator@group:FIN-Admins@/',
);

// Unresolvable role or principal falls back to a labelled unknown: the key must
// still be deterministic and distinct, not throw, so collection never aborts on
// one bad role assignment — the gap surfaces later, in the pre-flight report.
assert.equal(
  naturalKeyFor(
    'roleAssignment',
    { roleDefinitionId: 'role-guid-1', principalId: 'sp-guid-not-collected', directoryScopeId: '/' },
    { resolveSymbol: (id) => (id === 'role-guid-1' ? 'global:GlobalAdministrator' : null) },
  ),
  'roleAssignment:global:GlobalAdministrator@unknown:sp-guid-not-collected@/',
);

// A non-"/" directoryScopeId (administrative-unit scoped) is resolved the same
// way as principal/role, not left as a raw GUID, when it IS resolvable.
assert.equal(
  naturalKeyFor(
    'roleAssignment',
    { roleDefinitionId: 'role-guid-1', principalId: 'principal-guid-1', directoryScopeId: 'au-guid-1' },
    {
      resolveSymbol: (id) =>
        ({
          'role-guid-1': 'global:GlobalAdministrator',
          'principal-guid-1': 'group:FIN-Admins',
          'au-guid-1': 'administrativeUnit:EU-Region',
        })[id] ?? null,
    },
  ),
  'roleAssignment:global:GlobalAdministrator@group:FIN-Admins@administrativeUnit:EU-Region',
);

console.log('naturalKey.test.mjs — all assertions passed');
