/** Spec §10.6 — 81% of reference-tenant users are AD-synced; cloud-side restore
 * of a synced object is wrong by construction. */
export function refuseIfSynced(resource) {
  if (resource.payload?.onPremisesSyncEnabled === true) {
    return {
      refused: true,
      reason: 'onPremisesSyncEnabled=true — source of authority is on-premises Active Directory, cloud-side restore is refused',
    };
  }
  return { refused: false };
}
