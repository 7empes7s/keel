/** Spec §10.1. Fails loud on an unknown type — a silent default would be the
 * dangerous direction (a mis-classified tenant-lockout resource treated as
 * cosmetic bypasses every gate that follows). */
const BLAST_RADIUS = {
  user: 'access-affecting',
  authenticationStrengthPolicy: 'tenant-lockout',
  group: 'access-affecting',
  roleAssignment: 'tenant-lockout',
  namedLocation: 'tenant-lockout',
  conditionalAccessPolicy: 'tenant-lockout',
};

export function blastRadiusOf(type) {
  const c = BLAST_RADIUS[type];
  if (!c) throw new Error(`no blast-radius classification for resource type "${type}"`);
  return c;
}
