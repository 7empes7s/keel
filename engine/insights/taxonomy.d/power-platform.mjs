// Power Platform and Power BI workload reads.
export default Object.freeze({
  service: 'Power Platform',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here.
  categories: Object.freeze([
    { key: 'tenant', name: 'Tenant settings', types: ['power-platform-settings'] },
  ]),
  entries: Object.freeze({
    'power-platform-settings': {
      name: 'Power Platform or Power BI setting',
      priority: 'high',
      reason: 'Controls which apps and connectors can move tenant data out.',
    },
  }),
});
