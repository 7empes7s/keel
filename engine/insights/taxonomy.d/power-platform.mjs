// Power Platform and Power BI workload reads.
export default Object.freeze({
  service: 'Power Platform',
  prefix: /^(powerplatform|powerbi|powerapps|powerautomate|dataverse)/,
  fallback: 'tenant',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'environments', name: 'Environments', types: [], match: /environment/ },
    { key: 'roles', name: 'Admin roles', types: [], match: /role/ },
    { key: 'data', name: 'Data policies', types: [], match: /dlp|datapolic|connector/ },
    { key: 'tenant', name: 'Tenant settings', types: ['power-platform-settings'], match: /setting|tenant|config/ },
  ]),
  entries: Object.freeze({
    'power-platform-settings': {
      name: 'Power Platform or Power BI setting',
      priority: 'high',
      reason: 'Controls which apps and connectors can move tenant data out.',
    },
  }),
});
