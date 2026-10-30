// Microsoft Defender XDR types. Catalogue types take their priority from the
// catalogue's criticality and blast radius (see ../taxonomy.mjs).
export default Object.freeze({
  service: 'Defender',
  prefix: /^(defender|mde|xdr|attacksimulation|simulation|securityzone)/,
  fallback: 'tenant',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'roles', name: 'Admin roles', types: ['defenderRoleDefinition', 'defenderRoleAssignment', 'defenderCustomAppScope'], match: /role|scope/ },
    { key: 'threat', name: 'Threat policies and rules', types: ['defender-email-protection', 'defenderDetectionRule'], match: /foroffice|emailprotection|allowblock|polic|rule|detection|indicator|alert|antivirus|firewall/ },
    { key: 'simulation', name: 'Attack simulation', types: ['attackSimulation', 'simulationAutomation', 'attackSimulationPayload', 'attackSimulationLoginPage', 'attackSimulationLandingPage', 'attackSimulationNotification'], match: /simulation|training|payload/ },
    { key: 'exposure', name: 'Exposure management', types: ['securityZone'], match: /exposure|zone|vulnerab/ },
    { key: 'tenant', name: 'Tenant settings', types: [], match: /setting|config|tenant/ },
  ]),
  entries: Object.freeze({
    defenderRoleDefinition: { name: 'Defender admin role' },
    defenderRoleAssignment: { name: 'Defender admin role assignment' },
    defenderCustomAppScope: { name: 'Defender app access scope' },
    // Remaining kinds, batch 7.
    simulationAutomation: { name: 'Attack simulation automation' },
    attackSimulation: { name: 'Attack simulation' },
    // The tenant's own attack simulation content (gap audit 2026-10-30, section B).
    attackSimulationPayload: { name: 'Attack simulation payload' },
    attackSimulationLoginPage: { name: 'Attack simulation login page' },
    attackSimulationLandingPage: { name: 'Attack simulation landing page' },
    attackSimulationNotification: { name: 'Attack simulation notification email' },
    // Remaining kinds, batch 8.
    securityZone: { name: 'Exposure management zone' },
    // Remaining kinds, batch 9.
    defenderDetectionRule: { name: 'Custom detection rule' },
    // Read with the Exchange Online Defender cmdlets (a workload, so it sets its own priority).
    'defender-email-protection': {
      name: 'Defender email protection setting',
      priority: 'high',
      reason: 'An allow entry, a filter bypass or a protection exception lets mail through that would otherwise be blocked.',
    },
  }),
});
