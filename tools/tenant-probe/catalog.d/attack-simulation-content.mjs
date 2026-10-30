/** Catalogue family: the tenant's own attack simulation content (gap audit 2026-10-30, section B). See ../catalog.mjs for the entry shape. */
// The payloads, login pages, landing pages and end-user notifications a tenant made
// for Attack simulation training. Simulations and automations name them by id
// (m365-settings.mjs reads those); without them a simulation cannot be rebuilt.
// Each list is filtered to the tenant's own items (`source eq 'tenant'`): Microsoft's
// built-in catalogue is the same in every tenant and is not backed up. Microsoft's
// training modules are skipped too (engine/discovery/notGaps.mjs).
// v1.0 reads with AttackSimulation.Read.All, which the Collector already holds (the
// simulations are read with it). No writer is built yet: the backup is a record to
// rebuild from in the Defender portal. None of these objects holds a secret.
const TENANT_ONLY = "$filter=source eq 'tenant'";
export default [
  // The phishing message: sender, subject, body, technique and the login page it uses.
  { type: 'attackSimulationPayload', path: '/security/attackSimulation/payloads', version: 'v1.0', query: TENANT_ONLY,
    criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'detail holds the message body; a credential harvest payload names its login page by id.' },
  // The fake sign-in page a credential harvest payload links to.
  { type: 'attackSimulationLoginPage', path: '/security/attackSimulation/loginPages', version: 'v1.0', query: TENANT_ONLY,
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // The page a person sees after they click or enter a password.
  { type: 'attackSimulationLandingPage', path: '/security/attackSimulation/landingPages', version: 'v1.0', query: TENANT_ONLY,
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // The training assignment, reminder and positive reinforcement emails.
  { type: 'attackSimulationNotification', path: '/security/attackSimulation/endUserNotifications', version: 'v1.0', query: TENANT_ONLY,
    criticality: 'tier3', blastRadius: 'cosmetic' },
];
