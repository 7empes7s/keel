/**
 * SharePoint structure restore: the writes KEEL declares for the `sharepoint-structure`
 * backup (hub sites, site designs, site scripts and named sites' PnP templates).
 *
 * Pure data, in the shape of WORKLOAD_WRITE_OPERATIONS (coverage/qualification.mjs),
 * which spreads it in. Each entry is one operation with its own live proof
 * (workloadWriteQualification): it stays off until a live write and read-back on this
 * tenant is imported. Fields were declared from the PnP PowerShell documentation, not
 * measured live.
 *
 * Nothing here deletes or narrows: no Remove-, Unregister-, Revoke- or Grant- cmdlet,
 * and the site template write only adds what is missing and puts the navigation back.
 * engine/restore/workloads/sharepointStructure.mjs plans and runs them;
 * ops/powershell/run-cmdlet.ps1 ($AllowedPnPStructureWrites) holds the same allowlist.
 */
const PNP_DOCS = 'https://pnp.github.io/powershell/cmdlets';
const WORKLOAD = 'sharepoint-structure';
// App-only PnP with SharePoint Online Sites.FullControl.All acts as a SharePoint admin.
const RBAC = Object.freeze({ permissions: Object.freeze(['Sites.FullControl.All']), roles: Object.freeze([]) });

function declare(id, { name, family, resourceType, readBack, method, fields }) {
  return [id, Object.freeze({
    workload: WORKLOAD, family, resourceType, kind: 'cmdlet', module: 'PnP.PowerShell', session: 'pnp', method, name,
    readBack: `sharepoint-structure.${readBack}`, fields: Object.freeze([...fields]), rbac: RBAC,
    source: `${PNP_DOCS}/${method}.html`,
  })];
}

export const STRUCTURE_TEMPLATE_UPDATE = 'sharepoint-structure.site-template.update';
export const HUB_SITE_ADD = 'sharepoint-structure.hub-site.add';
export const HUB_SITE_UPDATE = 'sharepoint-structure.hub-site.update';
export const SITE_SCRIPT_ADD = 'sharepoint-structure.site-script.add';
export const SITE_SCRIPT_UPDATE = 'sharepoint-structure.site-script.update';
export const SITE_DESIGN_ADD = 'sharepoint-structure.site-design.add';
export const SITE_DESIGN_UPDATE = 'sharepoint-structure.site-design.update';

const HUB_FIELDS = ['Title', 'Description', 'LogoUrl', 'RequiresJoinApproval', 'HideNameInNavigation', 'SiteDesignId'];
const SCRIPT_FIELDS = ['Title', 'Description', 'Content'];
const DESIGN_FIELDS = ['Title', 'Description', 'WebTemplate', 'SiteScriptIds', 'PreviewImageUrl', 'PreviewImageAltText', 'IsDefault'];

export const SHAREPOINT_STRUCTURE_WRITE_OPERATIONS = Object.freeze(Object.fromEntries([
  // One site's missing lists, libraries, site columns and content types, and its navigation
  // put back as the backup had it, by applying a template KEEL builds from the backed-up one.
  declare(STRUCTURE_TEMPLATE_UPDATE, {
    name: 'Lists, libraries, columns and content types missing from a named site, and its navigation',
    family: 'siteTemplate', resourceType: 'sharepointSiteTemplate', readBack: 'site-templates', method: 'Invoke-PnPSiteTemplate',
    fields: ['lists', 'siteColumns', 'contentTypes', 'navigation'],
  }),
  // A site that was a hub and no longer is: registered as a hub again. Its title,
  // description and logo are put back by the update on the next run.
  declare(HUB_SITE_ADD, {
    name: 'SharePoint hub site registrations', family: 'hubSite', resourceType: 'sharepointHubSite', readBack: 'hub-sites',
    method: 'Register-PnPHubSite', fields: ['SiteUrl'],
  }),
  declare(HUB_SITE_UPDATE, {
    name: 'SharePoint hub site settings', family: 'hubSite', resourceType: 'sharepointHubSite', readBack: 'hub-sites',
    method: 'Set-PnPHubSite', fields: HUB_FIELDS,
  }),
  declare(SITE_SCRIPT_ADD, {
    name: 'SharePoint site scripts', family: 'siteScript', resourceType: 'sharepointSiteScript', readBack: 'site-scripts',
    method: 'Add-PnPSiteScript', fields: SCRIPT_FIELDS,
  }),
  declare(SITE_SCRIPT_UPDATE, {
    name: 'SharePoint site scripts', family: 'siteScript', resourceType: 'sharepointSiteScript', readBack: 'site-scripts',
    method: 'Set-PnPSiteScript', fields: SCRIPT_FIELDS,
  }),
  declare(SITE_DESIGN_ADD, {
    name: 'SharePoint site designs', family: 'siteDesign', resourceType: 'sharepointSiteDesign', readBack: 'site-designs',
    method: 'Add-PnPSiteDesign', fields: DESIGN_FIELDS,
  }),
  declare(SITE_DESIGN_UPDATE, {
    name: 'SharePoint site designs', family: 'siteDesign', resourceType: 'sharepointSiteDesign', readBack: 'site-designs',
    method: 'Set-PnPSiteDesign', fields: DESIGN_FIELDS,
  }),
]));

/**
 * The write cmdlets and the parameters each may receive from KEEL. The container
 * ($AllowedPnPStructureWrites) holds the same list. Invoke-PnPSiteTemplate takes the
 * site (`Url`, used to connect, never passed on) and the template KEEL built
 * (`TemplateGzip`, gzip and base64); its handlers are fixed in the container.
 */
export const SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS = Object.freeze({
  'Invoke-PnPSiteTemplate': Object.freeze(['TemplateGzip', 'Url']),
  'Register-PnPHubSite': Object.freeze(['Site']),
  'Set-PnPHubSite': Object.freeze(['Identity', ...HUB_FIELDS].sort()),
  'Add-PnPSiteScript': Object.freeze([...SCRIPT_FIELDS].sort()),
  'Set-PnPSiteScript': Object.freeze(['Identity', ...SCRIPT_FIELDS].sort()),
  'Add-PnPSiteDesign': Object.freeze([...DESIGN_FIELDS].sort()),
  'Set-PnPSiteDesign': Object.freeze(['Identity', ...DESIGN_FIELDS].sort()),
});
