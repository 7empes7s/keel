/**
 * SharePoint structure through PnP PowerShell: hub sites, site designs, site scripts and,
 * for each named site, its PnP site template (lists and libraries, site columns, content
 * types, navigation, features, regional and web settings, site header and footer).
 *
 * A workload of its own (`sharepoint-structure`), beside the SharePoint settings read
 * (`sharepoint-site-settings`, Graph). The content backup keeps files and list items; this
 * keeps the shape they live in, so a deleted library, column or content type can be put
 * back before the content is restored into it.
 *
 * Rules (the same as the other cmdlet workloads):
 *  - Read only. Only Get-PnPHubSite, Get-PnPSiteDesign, Get-PnPSiteScript (list, then one
 *    per script by -Identity for its JSON) and Get-PnPSiteTemplate run. The restore is a
 *    separate module (engine/restore/workloads/sharepointStructure.mjs) with its own allowlist.
 *  - Structure only. ops/powershell/run-cmdlet.ps1 fixes the template handlers: never
 *    Files, Pages, PageContents, TermGroups, PropertyBagEntries or Publishing. The term
 *    store is read by the SharePoint term store reader, not here.
 *  - Named sites, no crawl. Templates are read only for site collection roots named in
 *    the scope file (`sharepointStructureSites`, at most 25) on the tenant's own host.
 *    Anything else is refused and nothing is sent. The container checks the host again.
 *  - Declared fields only. Anything else an answer carries is dropped unread.
 *  - Errors are structured. A failed read is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified, per read: each family runs only once its own ledger row is
 *    live-qualified and enabled. A family not switched on yet is listed as skipped.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { registerWorkload } from '../registry.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const SHAREPOINT_STRUCTURE_WORKLOAD = 'sharepoint-structure';
export const SHAREPOINT_STRUCTURE_MODULE = 'PnP.PowerShell';
export const DEFAULT_MAX_OBJECTS = 500;
export const DEFAULT_MAX_SITES = 25;
// A template larger than this is not kept (a site with hundreds of lists); the run says so.
export const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;

const byId = (body) => guidOf(body.Id ?? body.ID);

/** The families. Fields are from the PnP PowerShell and SharePoint tenant admin documentation. */
export const FAMILIES = Object.freeze({
  hubSite: Object.freeze({
    operation: 'sharepoint-structure.hub-sites', cmdlet: 'Get-PnPHubSite', prefix: 'hub-site', identity: byId,
    fields: Object.freeze([
      'Title', 'SiteUrl', 'SiteId', 'Description', 'LogoUrl', 'Targets', 'SiteDesignId', 'RequiresJoinApproval', 'HideNameInNavigation', 'ParentHubSiteId',
    ]),
  }),
  siteDesign: Object.freeze({
    operation: 'sharepoint-structure.site-designs', cmdlet: 'Get-PnPSiteDesign', prefix: 'site-design', identity: byId,
    fields: Object.freeze(['Title', 'Description', 'WebTemplate', 'SiteScriptIds', 'PreviewImageUrl', 'PreviewImageAltText', 'IsDefault', 'Version']),
  }),
  siteScript: Object.freeze({
    operation: 'sharepoint-structure.site-scripts', cmdlet: 'Get-PnPSiteScript', prefix: 'site-script', identity: byId,
    // Content is the script's JSON (its actions), returned only when one script is read by -Identity.
    fields: Object.freeze(['Title', 'Description', 'Content', 'Version']),
  }),
  siteTemplate: Object.freeze({
    operation: 'sharepoint-structure.site-templates', cmdlet: 'Get-PnPSiteTemplate', prefix: 'site-template',
    fields: Object.freeze([
      'url', 'title', 'webSettings', 'regionalSettings', 'lists', 'contentTypes', 'siteColumns', 'navigation', 'siteFeatures', 'webFeatures',
      'templateXml', 'templateSha256', 'templateBytes',
    ]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const SHAREPOINT_STRUCTURE_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
// Stored for a restore, not compared: the template moves on every PnP version, so a
// change is shown from the summaries (lists, columns, content types, navigation).
export const TEMPLATE_STORAGE_FIELDS = Object.freeze(['templateXml', 'templateSha256', 'templateBytes']);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const SHAREPOINT_STRUCTURE_DESCRIPTOR = Object.freeze({
  type: 'sharepointStructure',
  workload: SHAREPOINT_STRUCTURE_WORKLOAD,
  adapter: 'sharepoint-structure',
  readOnly: true,
  enabledByDefault: false,
  operations: SHAREPOINT_STRUCTURE_OPERATIONS,
});

// The cmdlets this workload runs and the parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedPnPStructure) holds the same list and checks it
// again. -Url names the site the container connects to; it never reaches the cmdlet.
export const SHAREPOINT_STRUCTURE_CMDLET_PARAMETERS = Object.freeze({
  'Get-PnPHubSite': Object.freeze([]),
  'Get-PnPSiteDesign': Object.freeze([]),
  'Get-PnPSiteScript': Object.freeze(['Identity']),
  'Get-PnPSiteTemplate': Object.freeze(['Url']),
});
export const SHAREPOINT_STRUCTURE_CMDLETS = new Set(Object.keys(SHAREPOINT_STRUCTURE_CMDLET_PARAMETERS));

export class SharePointStructureScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SharePointStructureScopeError';
  }
}

/** Throws unless the cmdlet and every parameter name are allowlisted. */
export function assertSharePointStructureCmdlet({ cmdlet, parameters = {} }) {
  const allowed = SHAREPOINT_STRUCTURE_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new SharePointStructureScopeError(`${cmdlet} is not a SharePoint structure read KEEL runs; this workload never writes`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new SharePointStructureScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/**
 * A site as an operator names it: the tenant root (`https://contoso.sharepoint.com`) or a
 * site collection root (`/sites/<name>` or `/teams/<name>`). Returns the normalized URL.
 * Throws SharePointStructureScopeError for another host, a subsite or a path inside a
 * site, a query, a fragment or credentials.
 */
export function structureSite(value, tenantHost) {
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    throw new TypeError('tenantHost must be the tenant\'s SharePoint host, such as contoso.sharepoint.com');
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) throw new SharePointStructureScopeError('a site is a URL of at most 400 characters');
  let url;
  try { url = new URL(value); } catch { throw new SharePointStructureScopeError(`${value} is not a URL`); }
  const host = tenantHost.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host) throw new SharePointStructureScopeError(`${value} is not on ${host}`);
  if (url.search || url.hash || url.username || url.password || url.port) throw new SharePointStructureScopeError(`${value} carries a query, fragment or credentials`);
  const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length === 0) return `https://${host}`;
  if (segments.length !== 2 || !['sites', 'teams'].includes(segments[0].toLowerCase()) || !/^[A-Za-z0-9_.-]+$/.test(segments[1])) {
    throw new SharePointStructureScopeError(`${value} is not a site collection root; KEEL reads templates of named site collections only`);
  }
  return `https://${host}/${segments[0].toLowerCase()}/${segments[1]}`;
}

/** Runs one cmdlet through the bounded job transport. */
export async function sharePointStructureCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertSharePointStructureCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: SHAREPOINT_STRUCTURE_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: SHAREPOINT_STRUCTURE_CMDLETS });
}

// ---------------------------------------------------------------------------
// The template's summaries. PnP writes the template with .NET's XmlSerializer, which
// quotes every attribute with " and escapes <, >, & and " inside it, so the attributes
// of one element can be read without a full XML parser.

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, name) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[name.toLowerCase()];
});

/** The attributes of one start tag's text, decoded. The restore reads the template with it too. */
export function attributesOf(text) {
  const attributes = {};
  for (const [, name, value] of String(text ?? '').matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) attributes[name] = decode(value);
  return attributes;
}

/** Every `<name ...>` or `<name .../>` start tag in `xml`, as its attributes. */
function startTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*?)?\\/?>`, 'g'))].map((match) => attributesOf(match[1]));
}

/** The text between the first `<name ...>` and its `</name>`, or ''. */
export function section(xml, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`).exec(xml);
  return match ? match[1] : '';
}

const pick = (attributes, names) => Object.fromEntries(names.filter((name) => attributes[name] !== undefined).map((name) => [name, attributes[name]]));
const byText = (key) => (a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''));

const LIST_ATTRIBUTES = ['Title', 'Url', 'TemplateType', 'Description', 'OnQuickLaunch', 'EnableVersioning', 'MaxVersionLimit', 'EnableMinorVersions', 'EnableModeration', 'ForceCheckout', 'Hidden'];

/** One list or library: its settings, content types, column names and view names. */
function listSummary(attributes, body) {
  const columns = startTags(section(body, 'pnp:Fields'), 'Field').map((field) => field.Name ?? field.StaticName ?? field.DisplayName).filter(Boolean);
  const views = startTags(section(body, 'pnp:Views'), 'View').map((view) => view.DisplayName ?? view.Url).filter(Boolean);
  // Site columns added to the list are references, not list fields.
  const siteColumns = startTags(body, 'pnp:FieldRef').map((ref) => ref.Name ?? ref.ID).filter(Boolean);
  return {
    ...pick(attributes, LIST_ATTRIBUTES),
    contentTypes: startTags(body, 'pnp:ContentTypeBinding').map((binding) => binding.ContentTypeID).filter(Boolean),
    columns: columns.sort(),
    siteColumns: siteColumns.sort(),
    views: views.sort(),
  };
}

const features = (xml) => startTags(xml, 'pnp:Feature').map((feature) => pick(feature, ['ID', 'Deactivate'])).filter((feature) => feature.ID).sort(byText('ID'));

/**
 * Reads a PnP site template's summaries: what a person compares, field by field. The
 * template XML itself is kept apart (gzipped) for a restore.
 */
export function templateSummary(xml) {
  const lists = [...xml.matchAll(/<pnp:ListInstance(\s[^>]*?)(?:\/>|>([\s\S]*?)<\/pnp:ListInstance>)/g)]
    .map(([, attributes, body = '']) => listSummary(attributesOf(attributes), body))
    .sort(byText('Url'));
  const webSettings = startTags(xml, 'pnp:WebSettings')[0] ?? {};
  return {
    title: webSettings.Title ?? null,
    webSettings,
    regionalSettings: startTags(xml, 'pnp:RegionalSettings')[0] ?? {},
    lists,
    contentTypes: startTags(xml, 'pnp:ContentType').map((type) => pick(type, ['ID', 'Name', 'Group', 'Description', 'Hidden', 'ReadOnly', 'Sealed']))
      .filter((type) => type.ID).sort(byText('ID')),
    siteColumns: startTags(section(xml, 'pnp:SiteFields'), 'Field').map((field) => pick(field, ['ID', 'Name', 'StaticName', 'DisplayName', 'Type', 'Group', 'Required', 'Hidden']))
      .filter((field) => field.ID || field.Name).sort(byText('Name')),
    navigation: startTags(xml, 'pnp:NavigationNode').map((node) => pick(node, ['Title', 'Url', 'IsExternal'])),
    siteFeatures: features(section(xml, 'pnp:SiteFeatures')),
    webFeatures: features(section(xml, 'pnp:WebFeatures')),
  };
}

// Parts PnP rewrites on every export: the template's own id and the generator version.
const normalized = (xml) => xml.replace(/(<pnp:ProvisioningTemplate\b[^>]*?)\sID="[^"]*"/g, '$1').replace(/(<pnp:Preferences\b[^>]*?)\sGenerator="[^"]*"/g, '$1');

const templateFailure = (code, message) => new CmdletError(`Get-PnPSiteTemplate: ${message}`, {
  code, cmdlet: 'Get-PnPSiteTemplate', message, category: null, errorId: null, exitCode: 0, stderr: null, jobId: null,
});

/** Reads one site's template. Returns { resource } or { failure }. */
async function readSiteTemplate(url, powershell) {
  const spec = FAMILIES.siteTemplate;
  try {
    const { output } = await sharePointStructureCmdlet({ cmdlet: spec.cmdlet, parameters: { Url: url } }, powershell);
    const [xml] = output;
    if (output.length !== 1 || typeof xml !== 'string' || !/<pnp:ProvisioningTemplate\b/.test(xml)) {
      throw templateFailure('BAD_TEMPLATE', 'the site did not answer with one PnP template');
    }
    const bytes = Buffer.byteLength(xml, 'utf8');
    if (bytes > MAX_TEMPLATE_BYTES) throw templateFailure('TOO_LARGE', `the template is ${bytes} bytes; KEEL keeps templates up to ${MAX_TEMPLATE_BYTES} bytes`);
    const fields = {
      url,
      ...templateSummary(xml),
      templateXml: gzipSync(Buffer.from(xml, 'utf8')).toString('base64'),
      templateSha256: createHash('sha256').update(normalized(xml)).digest('hex'),
      templateBytes: bytes,
    };
    const fieldCoverage = Object.fromEntries(spec.fields.map((field) => [field, { status: 'observed', operation: spec.operation }]));
    fieldCoverage.templateXml.encoding = 'gzip+base64';
    const identity = url.toLowerCase();
    return { resource: { resourceKey: `${spec.prefix}:${identity}`, kind: 'siteTemplate', identity, fields, fieldCoverage } };
  } catch (error) {
    return { failure: { family: 'siteTemplate', operation: spec.operation, site: url, ...structuredFailure(error) } };
  }
}

async function readSiteTemplates({ powershell, sites, tenantHost, maxSites }) {
  const spec = FAMILIES.siteTemplate;
  if (!Array.isArray(sites)) throw new TypeError('sites must be a list of site URLs');
  const notConfigured = (code, message) => emptyRead({ failure: { family: 'siteTemplate', operation: spec.operation, status: 'not-configured', error: { code, message } } });
  if (sites.length === 0) return notConfigured('NO_SITES', 'no sites are named for the structure backup (sharepointStructureSites in the workload scope file)');
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    return notConfigured('NO_HOST', 'the workload scope file names no SharePoint host (sharepointHost), so the named sites cannot be checked');
  }
  const failures = [];
  const named = [];
  const seen = new Set();
  let capped = false;
  for (const value of sites) {
    let url;
    try {
      url = structureSite(value, tenantHost);
    } catch (error) {
      if (!(error instanceof SharePointStructureScopeError)) throw error;
      failures.push({ family: 'siteTemplate', operation: spec.operation, status: 'refused', error: { code: 'OUT_OF_SCOPE', message: error.message } });
      continue;
    }
    if (seen.has(url.toLowerCase())) continue;
    if (named.length >= maxSites) { capped = true; continue; }
    seen.add(url.toLowerCase());
    named.push(url);
  }
  const resources = [];
  for (const url of named) {
    const { resource, failure } = await readSiteTemplate(url, powershell);
    if (resource) resources.push(resource);
    else failures.push(failure);
  }
  const read = { ...emptyRead(), resources, capped, failures };
  if (resources.length === 0 && failures.length) read.failure = failures[0];
  return read;
}

/** Site scripts: the list names them, then each is read by -Identity for its JSON. */
async function readSiteScripts({ powershell, maxObjects }) {
  const spec = FAMILIES.siteScript;
  let listed;
  try {
    ({ output: listed } = await sharePointStructureCmdlet({ cmdlet: spec.cmdlet }, powershell));
  } catch (error) {
    return emptyRead({ failure: { family: 'siteScript', operation: spec.operation, ...structuredFailure(error) } });
  }
  const ids = [];
  let unidentified = 0;
  for (const body of listed) {
    const id = body && typeof body === 'object' ? byId(body) : null;
    if (!id) unidentified += 1;
    else if (!ids.includes(id)) ids.push(id);
  }
  const capped = ids.length > maxObjects;
  const answers = [];
  const failures = [];
  for (const id of ids.slice(0, maxObjects)) {
    try {
      const { output } = await sharePointStructureCmdlet({ cmdlet: spec.cmdlet, parameters: { Identity: id } }, powershell);
      if (output.length !== 1) {
        throw new CmdletError(`${spec.cmdlet}: ${output.length} scripts answered one id`, {
          code: output.length ? 'AMBIGUOUS_IDENTITY' : 'NOT_FOUND', cmdlet: spec.cmdlet, message: `${output.length} scripts answered one id; KEEL reads exactly one`,
          category: null, errorId: null, exitCode: 0, stderr: null, jobId: null,
        });
      }
      answers.push(...output);
    } catch (error) {
      failures.push({ family: 'siteScript', operation: spec.operation, ...structuredFailure(error) });
    }
  }
  const read = objectsFrom('siteScript', spec, answers, { maxObjects });
  return {
    ...emptyRead(), ...read, unidentified: read.unidentified + unidentified, capped: read.capped || capped,
    ...(failures.length ? { failures, failure: read.resources.length ? null : failures[0] } : {}),
  };
}

async function readListFamily(family, { powershell, maxObjects }) {
  const spec = FAMILIES[family];
  let output;
  try {
    ({ output } = await sharePointStructureCmdlet({ cmdlet: spec.cmdlet }, powershell));
  } catch (error) {
    return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
  }
  return { ...emptyRead(), ...objectsFrom(family, spec, output, { maxObjects }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. Callers outside tests use collectSharePointStructure.
 */
export async function readSharePointStructure({
  powershell = {}, families = FAMILY_NAMES, skipped = [], sites = [], tenantHost = null,
  maxObjects = DEFAULT_MAX_OBJECTS, maxSites = DEFAULT_MAX_SITES, now = () => new Date(),
}) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown SharePoint structure family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const family of families) {
    if (family === 'siteTemplate') reads[family] = await readSiteTemplates({ powershell, sites, tenantHost, maxSites });
    else if (family === 'siteScript') reads[family] = await readSiteScripts({ powershell, maxObjects });
    else reads[family] = await readListFamily(family, { powershell, maxObjects });
  }
  // A tenant may have no hub sites, designs or scripts: an empty answer is not a gap.
  return summarize({
    workload: SHAREPOINT_STRUCTURE_WORKLOAD, families, reads, skipped, maxObjects,
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run, per family: a family runs once its own read is
 * live-qualified and enabled. The others are listed as skipped (the run is partial).
 */
export function sharePointStructureActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const families = FAMILY_NAMES.filter((name) => rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = FAMILY_NAMES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: families.length > 0, reasons: families.length ? [] : skipped.map((entry) => entry.reason), families, skipped };
}

export const recordSharePointStructureRun = (client, { tenantRef, result }) => recordCmdletRun(client, SHAREPOINT_STRUCTURE_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectSharePointStructure(client, { tenantRef, ledger, powershell, sites, tenantHost, maxObjects, maxSites, now }) {
  const activation = sharePointStructureActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, SHAREPOINT_STRUCTURE_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readSharePointStructure({
    powershell, families: activation.families, skipped: activation.skipped, sites, tenantHost, maxObjects, maxSites, now,
  });
  const run = await recordSharePointStructureRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const sharePointStructureAdapter = Object.freeze({
  async collect() {
    throw new Error('the SharePoint structure workload adapter is disabled until live qualification; use collectSharePointStructure with the ledger');
  },
});

registerWorkload(SHAREPOINT_STRUCTURE_DESCRIPTOR, sharePointStructureAdapter);
