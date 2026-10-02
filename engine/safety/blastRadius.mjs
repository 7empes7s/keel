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

const BLAST_ORDER = ['cosmetic', 'access-affecting', 'tenant-lockout'];

/**
 * Task 60: conservative refusal policy over a dynamic-group impact prediction
 * (engine/graph/dynamicImpact.mjs). A prediction is never exact membership, so
 * this never relaxes anything — it only escalates:
 *  - any group not predicted unchanged is at least access-affecting; a
 *    role-assignable one is tenant-lockout (its members hold directory roles);
 *  - an automated change is refused when the prediction is incomplete (work
 *    budget exhausted), when a role-assignable group is only POSSIBLY affected
 *    (we cannot bound a privileged membership change), or when the number of
 *    possibly-affected groups exceeds the caller's ceiling.
 * An unclassified outcome throws, mirroring blastRadiusOf: a silent default is
 * the dangerous direction.
 */
export function dynamicImpactPolicy(prediction, { maxPossiblyAffected = Infinity } = {}) {
  let blastRadius = null;
  const raise = (level) => {
    if (blastRadius === null || BLAST_ORDER.indexOf(level) > BLAST_ORDER.indexOf(blastRadius)) blastRadius = level;
  };
  const refusals = [];
  let possibly = 0;
  for (const result of prediction.results) {
    if (!['predicted-change', 'possibly-affected', 'no-predicted-change'].includes(result.outcome)) {
      throw new Error(`unclassified dynamic impact outcome "${result.outcome}" for ${result.naturalKey}`);
    }
    if (result.outcome === 'no-predicted-change') continue;
    raise(result.isAssignableToRole ? 'tenant-lockout' : 'access-affecting');
    if (result.outcome === 'possibly-affected') {
      possibly += 1;
      if (result.isAssignableToRole) refusals.push({ reason: 'role-assignable-group-unbounded', group: result.naturalKey, causes: result.reasons });
    }
  }
  if (!prediction.complete) refusals.push({ reason: 'dynamic-prediction-incomplete', exhausted: prediction.budget?.exhausted ?? null });
  if (possibly > maxPossiblyAffected) refusals.push({ reason: 'possibly-affected-above-ceiling', possiblyAffected: possibly, ceiling: maxPossiblyAffected });
  if (!prediction.complete) raise('tenant-lockout');
  return { blastRadius, refused: refusals.length > 0, refusals, exactMembership: false };
}
