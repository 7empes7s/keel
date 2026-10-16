// SharePoint and OneDrive workload reads. OneDrive settings are SharePoint admin settings.
export default Object.freeze({
  service: 'SharePoint',
  entries: Object.freeze({
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
