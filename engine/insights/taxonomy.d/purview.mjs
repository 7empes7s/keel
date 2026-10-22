// Purview workload reads.
export default Object.freeze({
  service: 'Purview',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here.
  categories: Object.freeze([
    { key: 'labels', name: 'Sensitivity labels', types: ['purview-labels'] },
    { key: 'protection', name: 'Retention and data loss prevention', types: ['purview-retention-dlp'] },
    { key: 'governance', name: 'Retention labels and eDiscovery', types: ['purview-governance'] },
  ]),
  entries: Object.freeze({
    'purview-labels': {
      name: 'Sensitivity label',
      priority: 'high',
      reason: 'Controls encryption and who can open labelled files and mail.',
    },
    'purview-retention-dlp': {
      name: 'Retention or data loss prevention policy',
      priority: 'critical',
      reason: 'Shortening retention or loosening data loss prevention can delete data or let it leave the tenant.',
    },
    'purview-governance': {
      name: 'Retention label, auto-labeling or eDiscovery setting',
      priority: 'high',
      reason: 'Controls how long data is kept and what is held for legal cases.',
    },
  }),
});
