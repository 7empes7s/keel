// SharePoint and OneDrive workload reads. OneDrive settings are SharePoint admin settings.
export default Object.freeze({
  service: 'SharePoint',
  prefix: /^(sharepoint|onedrive|spo|iteminsights|externalconnection)/,
  fallback: 'tenant',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'sites', name: 'Sites and OneDrive', types: ['sharepoint-site-settings', 'onedrive-site-settings'], match: /site|onedrive|hub|library/ },
    { key: 'roles', name: 'Admin roles', types: [], match: /role|admin/ },
    { key: 'access', name: 'Sharing and access control', types: [], match: /sharing|access|guest|unmanaged|ipaddress|location/ },
    { key: 'tenant', name: 'Tenant settings', types: ['sharepointSettings', 'itemInsightsSettings'], match: /setting|tenant|insight|config/ },
    { key: 'connectors', name: 'Copilot connectors', types: ['externalConnection'], match: /connector|connection|search/ },
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
