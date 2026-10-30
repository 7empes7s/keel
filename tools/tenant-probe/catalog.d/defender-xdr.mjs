/** Catalogue family: Defender XDR settings beyond email (baselines gap audit, section E). See ../catalog.mjs for the entry shape. */
// Read-only Graph reads. No writer is built for either kind: the backup is a record
// to rebuild from. Neither object holds a secret (the sensor deployment access key
// is a separate action Keel never calls).
// Each read needs a Collector permission that the backup names when Graph refuses it
// (engine/discovery/grants.mjs), so until it is granted the read is refused and
// nothing else changes.
// Neither route documents $select (Microsoft Learn lists only $count, $filter, $skip and
// $top), so the whole object is read. The fields that change on their own (health,
// status, version, Microsoft's text and score) are server owned in
// engine/cir/serverOwned.mjs, so they never show as changes.
export default [
  // Defender for Identity sensors: which domain controllers, AD FS, AD CS and Entra
  // Connect servers are watched, and each sensor's settings (description, the DNS
  // names it covers, delayed update).
  { type: 'defenderIdentitySensor', path: '/security/identities/sensors', version: 'v1.0',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A sensor removed or set to delayed update leaves a server unwatched for identity attacks.' },
  // Secure Score improvement actions and the state an admin set on each: marked as
  // resolved through a third party, risk accepted (ignored) or planned, with its reason.
  // Microsoft adds and retires actions itself; those show as added or removed actions.
  { type: 'secureScoreControlProfile', path: '/security/secureScoreControlProfiles', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'Marking a control as resolved through a third party or ignored takes it out of the Secure Score to-do list.' },
];
