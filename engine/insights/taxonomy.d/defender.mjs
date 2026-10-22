// Microsoft Defender XDR types. Catalogue types take their priority from the
// catalogue's criticality and blast radius (see ../taxonomy.mjs).
export default Object.freeze({
  service: 'Defender',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here.
  categories: Object.freeze([
    { key: 'roles', name: 'Admin roles', types: ['defenderRoleDefinition', 'defenderRoleAssignment', 'defenderCustomAppScope'] },
    { key: 'simulation', name: 'Attack simulation', types: ['attackSimulation', 'simulationAutomation'] },
    { key: 'exposure', name: 'Exposure management', types: ['securityZone'] },
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
  }),
});
