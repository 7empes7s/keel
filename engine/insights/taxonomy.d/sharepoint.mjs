// SharePoint and OneDrive workload reads. OneDrive settings are SharePoint admin settings.
export default Object.freeze({
  service: 'SharePoint',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here.
  categories: Object.freeze([
    { key: 'sites', name: 'Sites and OneDrive', types: ['sharepoint-site-settings', 'onedrive-site-settings'] },
    { key: 'tenant', name: 'Tenant settings', types: ['sharepointSettings', 'itemInsightsSettings'] },
    { key: 'connectors', name: 'Copilot connectors', types: ['externalConnection'] },
  ]),
  entries: Object.freeze({
    // Remaining kinds, batch 7: catalogue types; priority comes from the catalogue.
    sharepointSettings: { name: 'SharePoint and OneDrive tenant setting' },
    itemInsightsSettings: { name: 'Item insights setting' },
    externalConnection: { name: 'Copilot connector' },
    'sharepoint-site-settings': {
      name: 'SharePoint setting',
      priority: 'high',
      reason: 'Controls external sharing and who can reach sites.',
    },
    'onedrive-site-settings': {
      name: 'OneDrive setting',
      priority: 'high',
      reason: 'Controls how files in OneDrive can be shared.',
    },
  }),
});
