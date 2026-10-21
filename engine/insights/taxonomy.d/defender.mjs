// Microsoft Defender XDR types. Catalogue types take their priority from the
// catalogue's criticality and blast radius (see ../taxonomy.mjs).
export default Object.freeze({
  service: 'Defender',
  entries: Object.freeze({
    defenderRoleDefinition: { name: 'Defender admin role' },
    defenderRoleAssignment: { name: 'Defender admin role assignment' },
    defenderCustomAppScope: { name: 'Defender app access scope' },
  }),
});
