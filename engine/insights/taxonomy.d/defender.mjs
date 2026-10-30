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
    // Antivirus, firewall, attack surface reduction and the like: set in Intune's
    // Endpoint security pages and stored as Intune settings catalog policies, but they
    // are Defender for Endpoint settings, so lists file them here (see `subkinds`).
    { key: 'endpoint', name: 'Endpoint security', types: ['defenderEndpointSecurityPolicy'], match: /endpointsecurity|antivirus|firewall|attacksurface|diskencryption|accountprotection|applicationcontrol/ },
    { key: 'threat', name: 'Threat policies and rules', types: ['defenderDetectionRule'], match: /foroffice|polic|rule|detection|indicator|alert/ },
    { key: 'simulation', name: 'Attack simulation', types: ['attackSimulation', 'simulationAutomation'], match: /simulation|training|payload/ },
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
    // Remaining kinds, batch 8.
    securityZone: { name: 'Exposure management zone' },
    // Remaining kinds, batch 9.
    defenderDetectionRule: { name: 'Custom detection rule' },
  }),
  // Kinds that are a part of a catalogued type of another service, told apart by a field
  // of each object (see settingKind in ../taxonomy.mjs). The object stays stored, backed
  // up and restored under `of`; only lists file it under this service.
  subkinds: Object.freeze({
    defenderEndpointSecurityPolicy: {
      name: 'Endpoint security policy',
      of: 'configurationPolicy',
      // templateReference.templateFamily of an Intune settings catalog policy, and the
      // plain name of each area. Endpoint privilege management is an Intune Suite
      // feature, not Defender, so it stays under Intune.
      families: Object.freeze({
        endpointSecurityAntivirus: 'Antivirus',
        endpointSecurityFirewall: 'Firewall',
        endpointSecurityAttackSurfaceReduction: 'Attack surface reduction',
        endpointSecurityEndpointDetectionAndResponse: 'Endpoint detection and response',
        endpointSecurityDiskEncryption: 'Disk encryption',
        endpointSecurityAccountProtection: 'Account protection',
        endpointSecurityApplicationControl: 'App control',
      }),
    },
  }),
});
