/** Spec §10.6 — 81% of reference-tenant users are AD-synced; cloud-side restore
 * of a synced object is wrong by construction.
 *
 * Roadmap task-111 widens the question from "is onPremisesSyncEnabled true" to
 * "who is the source of authority", without loosening the original rule:
 *
 * - onPremisesSyncEnabled === true is always 'on-premises', whatever else the
 *   resource claims. An explicit sourceAuthority hint can never downgrade a
 *   synced object to cloud-authoritative.
 * - An explicit sourceAuthority of 'on-premises' or 'hybrid' (a hybrid
 *   topology message, or a future adapter's observation) is refused too.
 * - A malformed hint is 'unknown' and refused: an unreadable authority claim is
 *   never treated as cloud.
 * - No hint and no sync flag stays 'cloud', as before. Most catalogue types
 *   (named locations, CA policies) never carry the field.
 *
 * Every caller (restore selection, applyWave, deletion guard) keeps calling
 * refuseIfSynced, so the hybrid refusal reaches every cloud write path. */

export const SOURCE_AUTHORITIES = Object.freeze(['cloud', 'on-premises', 'hybrid', 'unknown']);

const CLOUD_WRITE_REFUSED = Object.freeze(['on-premises', 'hybrid', 'unknown']);

export function sourceAuthorityOf(resource) {
  const payload = resource?.payload;
  if (payload?.onPremisesSyncEnabled === true) return 'on-premises';
  // Resource-level only: a Graph payload field is never read as an authority claim.
  const hint = resource?.sourceAuthority;
  if (hint === undefined || hint === null) return 'cloud';
  return SOURCE_AUTHORITIES.includes(hint) ? hint : 'unknown';
}

export function refuseIfSynced(resource) {
  const authority = sourceAuthorityOf(resource);
  if (resource?.payload?.onPremisesSyncEnabled === true) {
    return {
      refused: true,
      sourceAuthority: authority,
      reason: 'onPremisesSyncEnabled=true — source of authority is on-premises Active Directory, cloud-side restore is refused',
    };
  }
  if (CLOUD_WRITE_REFUSED.includes(authority)) {
    return {
      refused: true,
      sourceAuthority: authority,
      reason: `source of authority is ${authority} — the on-premises side owns this object and the hybrid runtime is deferred, so cloud-side write is refused`,
    };
  }
  return { refused: false, sourceAuthority: authority };
}
