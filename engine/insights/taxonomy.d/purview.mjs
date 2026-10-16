// Purview workload reads.
export default Object.freeze({
  service: 'Purview',
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
