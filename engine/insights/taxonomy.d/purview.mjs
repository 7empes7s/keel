// Purview workload reads.
export default Object.freeze({
  service: 'Purview',
  // Graph names for Purview kinds (security/labels/retentionLabels) start like this too.
  prefix: /^(purview|retentionlabel|sensitivitylabel|ediscovery)/,
  fallback: 'tenant',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'roles', name: 'Admin roles', types: [], match: /role/ },
    { key: 'labels', name: 'Sensitivity labels', types: ['purview-labels'], match: /sensitivity|^purviewlabels?$|^purviewlabelpolic/ },
    { key: 'protection', name: 'Retention and data loss prevention', types: ['purview-retention-dlp'], match: /dlp|datalossprevention|retentionpolic|retentionrule|retentiondlp/ },
    { key: 'governance', name: 'Retention labels and eDiscovery', types: ['purview-governance'], match: /governance|retention|label|ediscovery|hold|case|record|fileplan/ },
    { key: 'risk', name: 'Insider risk and communication rules', types: [], match: /insider|communication|supervision|barrier/ },
    { key: 'audit', name: 'Audit and alerts', types: [], match: /audit|alert/ },
    { key: 'tenant', name: 'Tenant settings', types: [], match: /setting|config/ },
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
