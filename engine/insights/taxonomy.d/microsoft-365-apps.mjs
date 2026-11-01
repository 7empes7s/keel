// Microsoft 365 apps: org settings for To Do, Forms and the Office apps, set in the
// Microsoft 365 admin center (Settings > Org settings). They are read through Graph
// /admin, not Entra ID, so they are listed under their own service.
export default Object.freeze({
  service: 'Microsoft 365 apps',
  prefix: /^(todo|forms|microsoft365apps|appsandservices)/,
  fallback: 'apps',
  categories: Object.freeze([
    { key: 'apps', name: 'App settings', types: ['todoSettings', 'formsSettings', 'microsoft365AppsInstallationOptions', 'appsAndServicesSettings'], match: /settings|options|installation/ },
  ]),
  entries: Object.freeze({
    todoSettings: { name: 'Microsoft To Do setting' },
    formsSettings: { name: 'Microsoft Forms setting' },
    microsoft365AppsInstallationOptions: { name: 'Microsoft 365 Apps installation option' },
    appsAndServicesSettings: { name: 'User owned apps and services setting' },
  }),
});
