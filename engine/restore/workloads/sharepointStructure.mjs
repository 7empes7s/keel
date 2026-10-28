/**
 * SharePoint structure restore: puts back what the `sharepoint-structure` backup holds
 * (engine/collect/workloads/sharepointStructure.mjs), through PnP PowerShell.
 *
 * What it writes, one operation per object (sharepointStructureWrites.mjs):
 *  - a named site's structure: the lists and libraries, site columns and content types
 *    the site no longer has, and its navigation as the backup had it. KEEL builds a
 *    small PnP template from the backed-up one, holding only those parts, and applies
 *    it with Invoke-PnPSiteTemplate. Files and list items come back from the content
 *    backup, into the library this puts back;
 *  - site scripts and site designs: a missing one is added again (it gets a new id; a
 *    design is pointed at its scripts' new ids), a changed one is set back;
 *  - hub sites: a site that is no longer a hub is registered again; a hub's title,
 *    description, logo, join approval and site design are set back.
 *
 * What it never does, whatever the backup holds:
 *  - delete or narrow: no list, column, content type, script, design or hub is removed,
 *    and an existing list, column or content type is never changed (each difference is
 *    listed for an administrator, with both values);
 *  - send content or permissions: the template KEEL applies never carries list items
 *    (DataRows), files, pages, permissions (Security), webhooks, custom actions,
 *    property bags or features; the container checks that again and fixes the handlers;
 *  - grant: who may use a design or join a hub (rights, targets) is listed.
 *
 * Rules (the same as the other workload restores):
 *  - Immutable plan, persisted as a restore_dry_run artifact; the approval and promotion
 *    checks are the existing ones.
 *  - Disabled until qualified, per operation (workloadWriteQualification).
 *  - Content effect guard: a site script that would start sending site data to a flow,
 *    change a site's external sharing or add people to a group needs the separate
 *    approval of exactly those effects.
 *  - No overwrite: each target is re-read first; a change since the plan makes only
 *    that operation `stale`. An unknown outcome is reconciled by reading, never resent.
 *  - Test tenant fixtures only (fixtureGuard.mjs): on the test tenant every site,
 *    script, design and hub written is a KEEL-RT- one; a default site design or the
 *    tenant's root site is tenant-wide and needs the separate tenant-wide option.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { structuredFailure } from '../../collect/workloads/exchange.mjs';
import {
  SHAREPOINT_STRUCTURE_MODULE, SHAREPOINT_STRUCTURE_WORKLOAD, SharePointStructureScopeError, attributesOf, readSharePointStructure, section,
  structureSite,
} from '../../collect/workloads/sharepointStructure.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { assertContentEffectApproval, disclosureFor } from '../../safety/contentEffects.mjs';
import { getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import { createWorkloadSettingsArtifact, loadWorkloadSource, workloadSettingsPlanDigest } from './cmdletSettings.mjs';
import { TEST_TENANT_REFS, fixtureProblem } from './fixtureGuard.mjs';
import {
  HUB_SITE_ADD, HUB_SITE_UPDATE, SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS, SHAREPOINT_STRUCTURE_WRITE_OPERATIONS, SITE_DESIGN_ADD,
  SITE_DESIGN_UPDATE, SITE_SCRIPT_ADD, SITE_SCRIPT_UPDATE, STRUCTURE_TEMPLATE_UPDATE,
} from './sharepointStructureWrites.mjs';

export const SHAREPOINT_STRUCTURE_RESTORE_EVIDENCE_KIND = 'workload-restore';
export const SHAREPOINT_STRUCTURE_WRITE_OPS = Object.freeze(Object.keys(SHAREPOINT_STRUCTURE_WRITE_OPERATIONS));
// The job descriptor travels in one environment variable (ops/powershell/run-job.sh),
// which Linux caps at 128 KiB: a bigger template is listed for an administrator.
export const MAX_TEMPLATE_GZIP_CHARS = 100_000;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNP_NAMESPACE_RE = /^http:\/\/schemas\.dev\.office\.com\/PnP\/\d{4}\/\d{2}\/ProvisioningSchema$/;
// Writes run in this order: scripts before the designs that use them, then hubs, then sites.
const FAMILY_ORDER = ['siteScript', 'siteDesign', 'hubSite', 'siteTemplate'];
const PREFIX_FAMILY = { 'hub-site': 'hubSite', 'site-design': 'siteDesign', 'site-script': 'siteScript', 'site-template': 'siteTemplate' };

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const lc = (value) => String(value ?? '').toLowerCase();
const truthy = (value) => value === true || value === 'true' || value === 'True';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ------------------------------------------------------------ values

/** A script's JSON compared by meaning, not by spacing or key order. */
function scriptJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}
const idList = (value) => (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map(lc).sort();

/** Whether a value read back is the value written, field by field. */
/**
 * Get-PnPSiteDesign reports the site type as SharePoint's number; Add- and Set-PnPSiteDesign
 * take PnP's SiteWebTemplate name (TeamSite, CommunicationSite, GrouplessTeamSite, ChannelSite).
 */
export const SITE_WEB_TEMPLATES = Object.freeze({ 64: 'TeamSite', 68: 'CommunicationSite', 1: 'GrouplessTeamSite', 69: 'ChannelSite' });
const webTemplateCode = (value) => {
  const text = String(value ?? '').trim();
  if (SITE_WEB_TEMPLATES[text]) return text;
  return Object.keys(SITE_WEB_TEMPLATES).find((code) => lc(SITE_WEB_TEMPLATES[code]) === lc(text)) ?? null;
};

/** The value a cmdlet parameter takes for a backed-up field: the site type by name, the rest as they are. */
function parameterValue(field, value) {
  return field === 'WebTemplate' ? SITE_WEB_TEMPLATES[webTemplateCode(value)] : value;
}

export function readsBackAs(field, read, written) {
  if (field === 'WebTemplate') return webTemplateCode(read) !== null && webTemplateCode(read) === webTemplateCode(written);
  if (field === 'Content') return same(scriptJson(read), scriptJson(written));
  if (field === 'SiteScriptIds') return same(idList(read), idList(written));
  if (field === 'SiteDesignId' || field === 'SiteUrl') return lc(read) === lc(written);
  if (typeof written === 'boolean') return truthy(read) === written && (read === true || read === false || /^(true|false)$/i.test(String(read)));
  return same(read, written);
}

/** True when a site script's JSON has no actions, which SharePoint refuses ("This site script has no actions"). */
export function scriptHasNoActions(content) {
  const parsed = scriptJson(content);
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && (!Array.isArray(parsed.actions) || parsed.actions.length === 0);
}
const NO_ACTIONS_REASON = 'its script has no actions, and SharePoint refuses a site script with no actions; an administrator restores it';

/** True when the cmdlet transport can carry the value: a scalar, or a list of strings. */
function sendable(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The site collection name of a URL (`KEEL-RT-x` for /sites/KEEL-RT-x), or null for the root site. */
function siteName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length === 2 ? decodeURIComponent(parts[1]) : null;
  } catch { return null; }
}

// ------------------------------------------------------------ content effects

// Site script actions that send site data out, open a site to guests or add people.
// A script only runs when its design is applied, but once added back it runs on every
// site that design creates. Declared from Microsoft's site script schema.
export const SCRIPT_EFFECT_VERBS = Object.freeze({
  triggerFlow: 'sends each new site\'s details to a Power Automate flow',
  setSiteExternalSharingCapability: 'changes who outside the organization a site can be shared with',
  addPrincipalToSPGroup: 'adds people or groups to a site\'s SharePoint groups',
});

function scriptVerbs(content) {
  const verbs = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.verb === 'string') verbs.add(node.verb);
    for (const child of Object.values(node)) walk(child);
  };
  const parsed = scriptJson(content);
  if (typeof parsed === 'string') {
    // Unreadable JSON: any verb name in the text counts, the safe direction.
    for (const verb of Object.keys(SCRIPT_EFFECT_VERBS)) if (parsed.includes(verb)) verbs.add(verb);
  } else walk(parsed);
  return verbs;
}

/** The effects of writing `after` over `before` for one site script (before is null for an add). */
export function siteScriptEffects({ naturalKey, before, after }) {
  if (same(scriptJson(before), scriptJson(after))) return [];
  const had = scriptVerbs(before);
  const effects = [];
  for (const verb of [...scriptVerbs(after)].sort()) {
    if (!SCRIPT_EFFECT_VERBS[verb]) continue;
    // A changed action of the same kind may point somewhere new, so it counts too.
    if (had.has(verb) && canonicalActions(before, verb) === canonicalActions(after, verb)) continue;
    effects.push({
      naturalKey, resourceType: 'sharepointSiteScript', field: `Content:${verb}`, effect: 'externally-sharing',
      before: had.has(verb) ? verb : null, after: verb, reason: SCRIPT_EFFECT_VERBS[verb], disclosure: disclosureFor('externally-sharing'),
    });
  }
  return effects;
}

function canonicalActions(content, verb) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.verb === verb) found.push(node);
    for (const child of Object.values(node)) walk(child);
  };
  walk(scriptJson(content));
  return canonical(found.map(canonical).sort());
}

// ------------------------------------------------------------ the template KEEL applies

// The only PnP elements a restore template may hold. The container checks the same list.
export const TEMPLATE_ELEMENTS = Object.freeze([
  'Provisioning', 'Preferences', 'Templates', 'ProvisioningTemplate',
  'SiteFields', 'ContentTypes', 'ContentType', 'FieldRefs', 'FieldRef',
  'Lists', 'ListInstance', 'ContentTypeBindings', 'ContentTypeBinding', 'Views', 'Fields', 'FieldDefaults', 'FieldDefault', 'Folders', 'Folder',
  'Navigation', 'GlobalNavigation', 'CurrentNavigation', 'StructuralNavigation', 'NavigationNode',
]);
// Parts of a list, folder or content type that are content, permissions or code: left
// out of what KEEL sends, and listed.
export const STRIPPED_ELEMENTS = Object.freeze([
  'DataRows', 'Security', 'Webhooks', 'UserCustomActions', 'PropertyBagEntries', 'DataSource', 'IRMSettings', 'DocumentTemplate',
]);
// The order the provisioning schema requires inside ProvisioningTemplate.
const SECTION_ORDER = Object.freeze(['Navigation', 'SiteFields', 'ContentTypes', 'Lists']);
const element = (name) => new RegExp(`<pnp:${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/pnp:${name}>)`, 'g');

/** The PnP element names in `xml` that a restore template may not carry. */
export function unsupportedElements(xml) {
  const text = String(xml);
  const names = new Set([...text.matchAll(/<\/?pnp:([A-Za-z]+)/g)].map((match) => match[1]));
  const bad = [...names].filter((name) => !TEMPLATE_ELEMENTS.includes(name));
  // The PnP namespace only ever as pnp:, and no DTD: no PnP element can hide under another prefix.
  if (/<!DOCTYPE|<!ENTITY/.test(text)) bad.push('!DOCTYPE');
  const declared = [...text.matchAll(/\bxmlns(:[A-Za-z0-9_.-]+)?\s*=\s*["']([^"']*)["']/g)];
  if (declared.some(([, prefix, uri]) => /schemas\.dev\.office\.com\/PnP/i.test(uri) && prefix !== ':pnp')) bad.push('xmlns');
  return bad.sort();
}

function strip(xml) {
  let text = xml;
  const removed = new Set();
  for (const name of STRIPPED_ELEMENTS) {
    text = text.replace(element(name), () => { removed.add(name); return ''; });
  }
  return { text, removed: [...removed].sort() };
}

const columnKey = (attributes) => (attributes.ID ? lc(attributes.ID).replace(/[{}]/g, '') : `name:${lc(attributes.Name ?? attributes.StaticName)}`);
const typeKey = (attributes) => lc(attributes.ID);
const listKey = (attributes) => lc(attributes.Url);
const startAttributes = (text) => attributesOf(/^<[^\s>/]+([^>]*?)\/?>/.exec(text)?.[1] ?? '');

/** Decodes the backed-up template (gzip and base64). Throws on anything else. */
export function backedUpTemplate(fields) {
  if (typeof fields?.templateXml !== 'string' || !fields.templateXml) throw new Error('the backup holds no template for this site');
  const xml = gunzipSync(Buffer.from(fields.templateXml, 'base64')).toString('utf8');
  if (!/<pnp:ProvisioningTemplate\b/.test(xml)) throw new Error('the backed-up template is not a PnP template');
  return xml;
}

/**
 * Builds the template KEEL applies: only the named site columns, content types and lists
 * of the backed-up template (each as it was, minus content, permissions and code), and
 * its navigation when `navigation` is true, with existing navigation replaced. Sections
 * follow the provisioning schema's order. Returns { xml, included, skipped, removed }: `skipped`
 * names what could not be sent and why.
 */
export function buildRestoreTemplate(source, { siteColumns = [], contentTypes = [], lists = [], navigation = false }) {
  const namespace = /xmlns:pnp="([^"]*)"/.exec(source)?.[1] ?? '';
  if (!PNP_NAMESPACE_RE.test(namespace)) throw new Error('the backed-up template does not name a PnP provisioning schema');
  const included = { siteColumns: [], contentTypes: [], lists: [], navigation: false };
  const skipped = [];
  const removed = new Set();
  const sections = [];
  const pick = (sectionName, pattern, wanted, keyOf, kind) => {
    const wantedKeys = new Set(wanted.map(lc));
    if (wantedKeys.size === 0) return;
    const body = section(source, `pnp:${sectionName}`);
    const kept = [];
    for (const [whole] of body.matchAll(pattern)) {
      const key = keyOf(startAttributes(whole));
      if (!wantedKeys.has(key)) continue;
      wantedKeys.delete(key);
      const cleaned = strip(whole);
      cleaned.removed.forEach((name) => removed.add(name));
      const bad = unsupportedElements(cleaned.text);
      if (bad.length) { skipped.push({ kind, key, reason: `it carries ${bad.join(', ')}, which KEEL does not send` }); continue; }
      kept.push(cleaned.text);
      included[kind].push(key);
    }
    for (const key of wantedKeys) skipped.push({ kind, key, reason: 'it is not in the backed-up template' });
    if (kept.length) sections.push({ order: SECTION_ORDER.indexOf(sectionName), xml: `<pnp:${sectionName}>${kept.join('')}</pnp:${sectionName}>` });
  };
  pick('SiteFields', /<Field\b[^>]*?(?:\/>|>[\s\S]*?<\/Field>)/g, siteColumns, columnKey, 'siteColumns');
  pick('ContentTypes', element('ContentType'), contentTypes, typeKey, 'contentTypes');
  pick('Lists', element('ListInstance'), lists, listKey, 'lists');
  if (navigation) {
    const [whole] = source.match(element('Navigation')) ?? [];
    const bad = whole ? unsupportedElements(whole) : [];
    if (!whole) skipped.push({ kind: 'navigation', key: 'navigation', reason: 'the backed-up template holds no navigation' });
    else if (bad.length) skipped.push({ kind: 'navigation', key: 'navigation', reason: `it uses ${bad.join(', ')} (not links KEEL can put back)` });
    else {
      // Existing links are replaced, so the site ends up with exactly the backed-up ones.
      const replaced = whole.replace(/<pnp:StructuralNavigation\b([^>]*?)(\/?)>/g, (_tag, attributes, close) => (
        `<pnp:StructuralNavigation${attributes.replace(/\sRemoveExistingNodes="[^"]*"/g, '')} RemoveExistingNodes="true"${close}>`));
      sections.push({ order: SECTION_ORDER.indexOf('Navigation'), xml: replaced });
      included.navigation = true;
    }
  }
  // The provisioning schema fixes the order (Navigation, SiteFields, ContentTypes, Lists),
  // and PnP refuses a template out of it ("Template is not valid").
  sections.sort((a, b) => a.order - b.order);
  const xml = [
    '<?xml version="1.0"?>',
    `<pnp:Provisioning xmlns:pnp="${namespace}">`,
    '<pnp:Preferences Generator="KEEL restore" />',
    // ID is xs:ID, so the Templates and ProvisioningTemplate ids must differ.
    '<pnp:Templates ID="KEEL-RESTORE-TEMPLATES">',
    '<pnp:ProvisioningTemplate ID="KEEL-RESTORE" Version="1">',
    ...sections.map((item) => item.xml),
    '</pnp:ProvisioningTemplate>',
    '</pnp:Templates>',
    '</pnp:Provisioning>',
  ].join('\n');
  return { xml, included, skipped, removed: [...removed].sort() };
}

// ------------------------------------------------------------ cmdlets

export class SharePointStructureWriteScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SharePointStructureWriteScopeError';
  }
}

/** Runs one declared write cmdlet through the bounded job transport; anything else is refused unsent. */
export async function structureWriteCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  const allowed = SHAREPOINT_STRUCTURE_WRITE_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new SharePointStructureWriteScopeError(`${cmdlet} is not a SharePoint structure write KEEL runs`);
  for (const [name, value] of Object.entries(parameters)) {
    if (!allowed.includes(name)) throw new SharePointStructureWriteScopeError(`${cmdlet} does not take ${name} from KEEL`);
    if (!sendable(value)) throw new SharePointStructureWriteScopeError(`${cmdlet} -${name}: KEEL only sends text, numbers, switches and lists of text`);
  }
  if (cmdlet === 'Invoke-PnPSiteTemplate') {
    if (typeof parameters.TemplateGzip !== 'string' || parameters.TemplateGzip.length > MAX_TEMPLATE_GZIP_CHARS) {
      throw new SharePointStructureWriteScopeError(`the template must be gzip and base64 of at most ${MAX_TEMPLATE_GZIP_CHARS} characters`);
    }
    const xml = gunzipSync(Buffer.from(parameters.TemplateGzip, 'base64')).toString('utf8');
    const bad = unsupportedElements(xml);
    if (bad.length) throw new SharePointStructureWriteScopeError(`the template carries ${bad.join(', ')}, which KEEL never sends`);
  }
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: SHAREPOINT_STRUCTURE_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: new Set([cmdlet]) });
}

// ------------------------------------------------------------ source and live

const familyOf = (key) => PREFIX_FAMILY[String(key).split(':')[0]] ?? null;
const resources = (read, family) => (read?.resources ?? []).filter((item) => item.kind === family);

/** Why nothing in this family (or this site) is known now, or null. */
function liveGap(live, family, url = null) {
  const failures = [...(live?.failures ?? []), ...(live?.unavailable ?? [])].filter((item) => item.family === family);
  const gap = url ? failures.find((item) => !item.site || lc(item.site) === lc(url)) : failures.find((item) => !item.site) ?? (family !== 'siteTemplate' ? failures[0] : null);
  if (gap) return gap;
  if (family === 'siteTemplate' && url && !resources(live, family).some((item) => lc(item.fields?.url) === lc(url))) {
    return { family, status: 'not read' };
  }
  return live?.discovery?.capped ? { family, status: 'capped at its object limit' } : null;
}

/** The live object that stands for a backed-up one: same id, or for a re-created one the same title (or a hub's site). */
export function matchLive(family, observation, live) {
  const candidates = resources(live, family);
  const byKey = candidates.find((item) => item.resourceKey === observation.resourceKey);
  if (family === 'hubSite') {
    const url = lc(observation.fields?.SiteUrl);
    return candidates.find((item) => url && lc(item.fields?.SiteUrl) === url) ?? byKey ?? null;
  }
  if (byKey || family === 'siteTemplate') return byKey ?? null;
  const title = lc(observation.fields?.Title);
  const titled = candidates.filter((item) => title && lc(item.fields?.Title) === title);
  return titled.length === 1 ? titled[0] : null;
}

/**
 * Whether a title match for a backed-up script or design could be another object: the
 * backup holds another one with that title, or the live one with that title is itself
 * in the backup under its own id. Then a title match is never used.
 */
function titleShared(family, observation, source, live) {
  const title = lc(observation?.fields?.Title);
  if (!title || family === 'hubSite' || family === 'siteTemplate') return false;
  const backed = (source?.observations ?? []).filter((item) => familyOf(item.resourceKey) === family && item.resourceKey !== observation.resourceKey);
  if (backed.some((item) => lc(item.fields?.Title) === title)) return true;
  const backedKeys = new Set(backed.map((item) => item.resourceKey));
  return resources(live, family).some((item) => lc(item.fields?.Title) === title && backedKeys.has(item.resourceKey));
}

/** The live id of a backed-up script or design id: itself, or the re-created one with its title. */
function mapId(id, { family, source, live }) {
  if (!id || lc(id) === ZERO_GUID) return lc(id || ZERO_GUID);
  const prefix = family === 'siteScript' ? 'site-script' : 'site-design';
  const current = resources(live, family);
  if (current.some((item) => lc(item.identity) === lc(id))) return lc(id);
  const backed = (source.observations ?? []).find((item) => item.resourceKey === `${prefix}:${lc(id)}`);
  if (!backed || titleShared(family, backed, source, live)) return null;
  const title = lc(backed.fields?.Title);
  const titled = current.filter((item) => title && lc(item.fields?.Title) === title);
  return titled.length === 1 ? lc(titled[0].identity) : null;
}

// What a re-read compares for each kind of target.
const TEMPLATE_PARTS = ['lists', 'siteColumns', 'contentTypes', 'navigation'];
function fingerprint(family, entry) {
  if (!entry) return 'absent';
  if (family === 'siteTemplate') return sha256(Object.fromEntries(TEMPLATE_PARTS.map((part) => [part, entry.fields?.[part] ?? null])));
  return sha256({ identity: entry.identity ?? null, fields: entry.fields, fieldCoverage: entry.fieldCoverage });
}

// ------------------------------------------------------------ planning

const OBJECT_FIELDS = {
  siteScript: SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[SITE_SCRIPT_UPDATE].fields,
  siteDesign: SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[SITE_DESIGN_UPDATE].fields,
  hubSite: SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[HUB_SITE_UPDATE].fields,
};
const OPS = {
  siteScript: { add: SITE_SCRIPT_ADD, update: SITE_SCRIPT_UPDATE },
  siteDesign: { add: SITE_DESIGN_ADD, update: SITE_DESIGN_UPDATE },
  hubSite: { add: HUB_SITE_ADD, update: HUB_SITE_UPDATE },
};
// Hub settings KEEL lists rather than writes.
const HUB_MANUAL = Object.freeze({
  Targets: 'who may join sites to the hub is granted by hand (Grant-PnPHubSiteRights or the SharePoint admin center)',
  ParentHubSiteId: 'joining a hub to a parent hub is done by hand in the SharePoint admin center',
});

/** How the fixture guard sees one object: its names, and whether it is tenant-wide. */
export function structureTarget(family, entries) {
  const names = new Set();
  let tenantWide = false;
  for (const entry of entries.filter(Boolean)) {
    const fields = entry.fields ?? {};
    if (family === 'siteTemplate') {
      const name = siteName(fields.url);
      if (name) names.add(name); else tenantWide = true;
      continue;
    }
    if (fields.Title) names.add(String(fields.Title));
    if (family === 'hubSite') {
      const name = siteName(fields.SiteUrl);
      if (name) names.add(name); else tenantWide = true;
    }
    // A default design is offered for every new site in the tenant.
    if (family === 'siteDesign' && truthy(fields.IsDefault)) tenantWide = true;
  }
  return { names: [...names], tenantWide };
}

function guard(family, entries, { key, tenantRef, testTenantRefs, allowTenantWide }) {
  const { names, tenantWide } = structureTarget(family, entries);
  return fixtureProblem({ tenantRef, testTenantRefs, label: key, names, tenantWide, allowTenantWide });
}

/** The changes for one script, design or hub against what is live now (null `current` for an add). */
function objectChanges(family, { observation, current, mapped, manual, key }) {
  const changes = [];
  for (const field of OBJECT_FIELDS[family]) {
    const sourceStatus = observation.fieldCoverage?.[field]?.status ?? 'unknown';
    if (sourceStatus !== 'observed') {
      if (!current) continue;
      if ((current.fieldCoverage?.[field]?.status ?? 'unknown') !== sourceStatus) {
        manual.push({ resourceKey: key, field, reason: `${sourceStatus} in the backup, so there is no value KEEL can compare` });
      }
      continue;
    }
    const after = Object.hasOwn(mapped, field) ? mapped[field] : observation.fields?.[field] ?? null;
    if (after === undefined) continue;
    const before = current ? current.fields?.[field] ?? null : null;
    if (current && (current.fieldCoverage?.[field]?.status ?? 'unknown') !== 'observed') {
      manual.push({ resourceKey: key, field, after, reason: 'not read from the tenant now, so KEEL cannot compare it' });
      continue;
    }
    if (current && readsBackAs(field, before, after)) continue;
    if (!current && (after === null || after === '')) continue;
    if (!sendable(after)) {
      manual.push({ resourceKey: key, field, before, after, reason: 'the value is structured, and KEEL only sends text, numbers, switches and lists of text; an administrator applies it' });
      continue;
    }
    changes.push({ field, before, after });
  }
  return changes;
}

/** Plans one script, design or hub. Pushes onto the plan parts; returns the matched live key. */
function planObject(family, observation, context) {
  const { live, source, manual, operations, refusals, effects, liveFingerprints } = context;
  const key = observation.resourceKey;
  const naturalKey = `${SHAREPOINT_STRUCTURE_WORKLOAD}:${key}`;
  const gap = liveGap(live, family);
  if (gap) {
    manual.push({ resourceKey: key, field: null, reason: `the live ${family} read was ${gap.status ?? 'not available'}, so no change is planned`, error: gap.error ?? null });
    return null;
  }
  const current = matchLive(family, observation, live);
  const title = lc(observation.fields?.Title);
  if (!current && family !== 'hubSite' && title && resources(live, family).filter((item) => lc(item.fields?.Title) === title).length > 1) {
    manual.push({ resourceKey: key, field: null, reason: 'several objects in the tenant have its title, so KEEL cannot tell which one it is; an administrator restores it' });
    return null;
  }
  // A match by title alone must not be another backed-up object with the same title.
  if (current?.resourceKey !== key && titleShared(family, observation, source, live)) {
    manual.push({ resourceKey: key, field: null, reason: 'another object in the backup or the tenant has its title, so KEEL cannot tell which one it is; an administrator restores it' });
    return null;
  }
  const mapped = {};
  if (family === 'siteDesign' && observation.fieldCoverage?.SiteScriptIds?.status === 'observed') {
    const ids = idList(observation.fields.SiteScriptIds);
    const mappedIds = ids.map((id) => mapId(id, { family: 'siteScript', source, live }));
    if (mappedIds.some((id) => id === null)) {
      manual.push({
        resourceKey: key, field: 'SiteScriptIds', after: ids,
        reason: 'one of its site scripts is not in the tenant yet; this restore adds it back when the backup holds it. Run the restore again afterwards to put this design back',
      });
      return current?.resourceKey ?? null;
    }
    mapped.SiteScriptIds = mappedIds;
  }
  if (family === 'hubSite') {
    for (const [field, reason] of Object.entries(HUB_MANUAL)) {
      const before = current?.fields?.[field] ?? null;
      const after = observation.fields?.[field] ?? null;
      if (observation.fieldCoverage?.[field]?.status === 'observed' && !same(before, after) && !(lc(after) === ZERO_GUID || after === null || (Array.isArray(after) && !after.length))) {
        manual.push({ resourceKey: key, field, before, after, reason });
      }
    }
    if (observation.fieldCoverage?.SiteDesignId?.status === 'observed') {
      const designId = mapId(observation.fields.SiteDesignId, { family: 'siteDesign', source, live });
      if (designId === null) {
        manual.push({ resourceKey: key, field: 'SiteDesignId', after: observation.fields.SiteDesignId, reason: 'its site design is not in the tenant yet; run the restore again once the design is back' });
        mapped.SiteDesignId = undefined;
      } else mapped.SiteDesignId = designId;
    }
  }
  liveFingerprints[key] = current ? fingerprint(family, current) : 'absent';
  const write = OPS[family];
  let op;
  if (!current) {
    if (family === 'hubSite') {
      let site;
      try { site = structureSite(String(observation.fields?.SiteUrl ?? ''), new URL(String(observation.fields?.SiteUrl ?? '')).hostname); } catch { site = null; }
      if (!site) {
        manual.push({ resourceKey: key, field: null, reason: 'its site address is not a site collection on the tenant\'s SharePoint host; an administrator registers it' });
        return null;
      }
      manual.push({ resourceKey: key, field: null, reason: 'once it is a hub again, run the restore again to put back its title, description, logo and join settings' });
      op = { kind: 'add', operationId: write.add, cmdlet: 'Register-PnPHubSite', parameters: { Site: site }, changes: [{ field: 'SiteUrl', before: null, after: site }] };
    } else {
      const changes = objectChanges(family, { observation, current: null, mapped, manual, key });
      if (family === 'siteScript' && changes.some((change) => change.field === 'Content' && scriptHasNoActions(change.after))) {
        manual.push({ resourceKey: key, field: 'Content', reason: NO_ACTIONS_REASON });
        return null;
      }
      if (!changes.some((change) => change.field === 'Title')) {
        manual.push({ resourceKey: key, field: null, reason: 'the backup holds no title for it, so KEEL cannot add it back' });
        return null;
      }
      if (family === 'siteDesign' && !changes.some((change) => change.field === 'WebTemplate' && webTemplateCode(change.after) !== null)) {
        manual.push({ resourceKey: key, field: null, reason: 'the backup holds no site type KEEL knows for it, so KEEL cannot add it back' });
        return null;
      }
      op = {
        kind: 'add', operationId: write.add, cmdlet: SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[write.add].method, changes,
        parameters: Object.fromEntries(changes.map(({ field, after }) => [field, parameterValue(field, after)])),
      };
      manual.push({ resourceKey: key, field: null, reason: family === 'siteDesign'
        ? 'it comes back with a new id; who may use it (its rights) is granted again by hand'
        : 'it comes back with a new id; designs that used it are pointed at the new id when they are restored' });
    }
  } else {
    let changes = objectChanges(family, { observation, current, mapped, manual, key });
    const unknownType = changes.find((change) => change.field === 'WebTemplate' && webTemplateCode(change.after) === null);
    if (unknownType) {
      manual.push({ resourceKey: key, field: 'WebTemplate', before: unknownType.before, after: unknownType.after, reason: 'KEEL does not know this site type; an administrator sets it' });
      changes = changes.filter((change) => change !== unknownType);
    }
    const emptyScript = family === 'siteScript' && changes.find((change) => change.field === 'Content' && scriptHasNoActions(change.after));
    if (emptyScript) {
      manual.push({ resourceKey: key, field: 'Content', before: emptyScript.before, after: emptyScript.after, reason: NO_ACTIONS_REASON });
      changes = changes.filter((change) => change !== emptyScript);
    }
    if (!changes.length) return current.resourceKey;
    op = {
      kind: 'update', operationId: write.update, cmdlet: SHAREPOINT_STRUCTURE_WRITE_OPERATIONS[write.update].method, changes,
      parameters: { Identity: family === 'hubSite' ? current.fields.SiteUrl : current.identity, ...Object.fromEntries(changes.map(({ field, after }) => [field, parameterValue(field, after)])) },
    };
  }
  const notFixture = guard(family, [current, observation, op.parameters.Title ? { fields: { ...observation.fields, ...op.parameters } } : null], { key, ...context });
  if (notFixture) {
    refusals.push({ naturalKey, reason: `not-a-fixture: ${notFixture}` });
    return current?.resourceKey ?? null;
  }
  if (family === 'siteScript') {
    const change = op.changes.find((item) => item.field === 'Content');
    if (change) effects.push(...siteScriptEffects({ naturalKey, before: current ? current.fields?.Content ?? null : null, after: change.after }));
  }
  if (family === 'siteDesign') {
    // A design that starts using a script which sends site data out needs the same approval.
    const change = op.changes.find((item) => item.field === 'SiteScriptIds');
    if (change) {
      const had = new Set(idList(current?.fields?.SiteScriptIds ?? []).map(lc));
      for (const id of idList(change.after).map(lc).filter((item) => !had.has(item))) {
        const script = resources(live, 'siteScript').find((item) => lc(item.identity) === id);
        for (const effect of siteScriptEffects({ naturalKey, before: null, after: script?.fields?.Content ?? null })) {
          effects.push({ ...effect, resourceType: 'sharepointSiteDesign', field: `SiteScriptIds:${id}:${effect.after}` });
        }
      }
    }
  }
  operations.push({ key, family, resourceKey: key, naturalKey, liveKey: current?.resourceKey ?? null, ...op });
  return current?.resourceKey ?? null;
}

const listDiffFields = ['Title', 'TemplateType', 'Description', 'OnQuickLaunch', 'EnableVersioning', 'MaxVersionLimit', 'EnableMinorVersions', 'EnableModeration', 'ForceCheckout', 'Hidden', 'contentTypes', 'columns', 'siteColumns', 'views'];

/** Plans one site: what is missing is added, the navigation put back, the rest listed. */
function planSite(observation, context) {
  const { live, manual, operations, refusals, liveFingerprints } = context;
  const key = observation.resourceKey;
  const naturalKey = `${SHAREPOINT_STRUCTURE_WORKLOAD}:${key}`;
  const url = observation.fields?.url;
  const gap = liveGap(live, 'siteTemplate', url);
  if (gap) {
    manual.push({ resourceKey: key, field: null, reason: `the site could not be read now (${gap.status ?? 'not available'}), so no change is planned`, error: gap.error ?? null });
    return null;
  }
  const current = matchLive('siteTemplate', observation, live);
  liveFingerprints[key] = fingerprint('siteTemplate', current);
  const src = observation.fields ?? {};
  const now = current.fields ?? {};
  const missing = (part, keyOf) => {
    const have = new Set((now[part] ?? []).map(keyOf));
    return (src[part] ?? []).filter((item) => !have.has(keyOf(item)));
  };
  const listUrl = (item) => lc(item.Url);
  const missingLists = missing('lists', listUrl);
  const missingColumns = missing('siteColumns', columnKey);
  const missingTypes = missing('contentTypes', typeKey);
  const navigationDiffers = !same(src.navigation ?? [], now.navigation ?? []);

  // Differences KEEL does not write: listed with both values.
  const listed = (field, before, after, reason) => manual.push({ resourceKey: key, field, before, after, reason });
  const EXISTING = 'it exists, and KEEL never changes an existing one; an administrator applies the difference';
  for (const list of src.lists ?? []) {
    const live = (now.lists ?? []).find((item) => listUrl(item) === listUrl(list));
    if (!live) continue;
    for (const field of listDiffFields) {
      if (!same(live[field] ?? null, list[field] ?? null)) listed(`lists/${list.Url}/${field}`, live[field] ?? null, list[field] ?? null, EXISTING);
    }
  }
  for (const [part, keyOf, label] of [['siteColumns', columnKey, 'site column'], ['contentTypes', typeKey, 'content type']]) {
    for (const item of src[part] ?? []) {
      const live = (now[part] ?? []).find((entry) => keyOf(entry) === keyOf(item));
      if (live && !same(live, item)) listed(`${part}/${item.Name ?? item.ID}`, live, item, `this ${label} ${EXISTING.slice(3)}`);
    }
  }
  for (const field of ['title', 'webSettings', 'regionalSettings', 'siteFeatures', 'webFeatures']) {
    if (observation.fieldCoverage?.[field]?.status === 'observed' && !same(now[field] ?? null, src[field] ?? null)) {
      listed(field, now[field] ?? null, src[field] ?? null, field.endsWith('Features')
        ? 'KEEL never turns site features on or off; an administrator applies the difference'
        : 'site settings are not written by KEEL; an administrator applies the difference');
    }
  }
  for (const [part, keyOf, label] of [['lists', listUrl, 'lists'], ['siteColumns', columnKey, 'site columns'], ['contentTypes', typeKey, 'content types']]) {
    const have = new Set((src[part] ?? []).map(keyOf));
    const extra = (now[part] ?? []).filter((item) => !have.has(keyOf(item)));
    if (extra.length) {
      listed(part, extra.map((item) => item.Url ?? item.Name ?? item.ID), null, `${label} newer than the backup; KEEL never deletes them`);
    }
  }

  if (!missingLists.length && !missingColumns.length && !missingTypes.length && !navigationDiffers) return current.resourceKey;
  let built;
  try {
    built = buildRestoreTemplate(backedUpTemplate(src), {
      siteColumns: missingColumns.map(columnKey), contentTypes: missingTypes.map(typeKey), lists: missingLists.map(listUrl), navigation: navigationDiffers,
    });
  } catch (error) {
    manual.push({ resourceKey: key, field: null, reason: `${error.message}; an administrator puts the structure back` });
    return current.resourceKey;
  }
  for (const item of built.skipped) manual.push({ resourceKey: key, field: `${item.kind}/${item.key}`, reason: `not sent: ${item.reason}; an administrator puts it back` });
  if (built.removed.length) {
    manual.push({ resourceKey: key, field: null, reason: `left out of what KEEL sends: ${built.removed.join(', ')} (list items come back from the content backup; permissions, webhooks, custom actions, property bags and document templates are put back by hand)` });
  }
  const { included } = built;
  if (!included.lists.length && !included.siteColumns.length && !included.contentTypes.length && !included.navigation) return current.resourceKey;
  const gzip = gzipSync(Buffer.from(built.xml, 'utf8')).toString('base64');
  if (gzip.length > MAX_TEMPLATE_GZIP_CHARS) {
    manual.push({ resourceKey: key, field: null, reason: 'what is missing is too large for one write; an administrator applies the backed-up template' });
    return current.resourceKey;
  }
  const changes = [
    ...(included.lists.length ? [{ field: 'lists', before: null, after: missingLists.filter((item) => included.lists.includes(listUrl(item))).map((item) => item.Url) }] : []),
    ...(included.siteColumns.length ? [{ field: 'siteColumns', before: null, after: missingColumns.filter((item) => included.siteColumns.includes(columnKey(item))).map((item) => item.Name ?? item.ID) }] : []),
    ...(included.contentTypes.length ? [{ field: 'contentTypes', before: null, after: missingTypes.filter((item) => included.contentTypes.includes(typeKey(item))).map((item) => item.Name ?? item.ID) }] : []),
    ...(included.navigation ? [{ field: 'navigation', before: now.navigation ?? [], after: src.navigation ?? [] }] : []),
  ];
  const notFixture = guard('siteTemplate', [observation, current], { key, ...context });
  if (notFixture) {
    refusals.push({ naturalKey, reason: `not-a-fixture: ${notFixture}` });
    return current.resourceKey;
  }
  operations.push({
    key, family: 'siteTemplate', resourceKey: key, naturalKey, liveKey: current.resourceKey, kind: 'update', operationId: STRUCTURE_TEMPLATE_UPDATE,
    cmdlet: 'Invoke-PnPSiteTemplate', changes, parameters: { Url: url, TemplateGzip: gzip },
    expect: { lists: included.lists, siteColumns: included.siteColumns, contentTypes: included.contentTypes, navigation: included.navigation ? src.navigation ?? [] : null },
  });
  return current.resourceKey;
}

/** The SharePoint host the backup was taken from, from its site and hub addresses. */
export function sourceTenantHost(source) {
  const hosts = new Set();
  for (const item of source?.observations ?? []) {
    for (const value of [item.fields?.url, item.fields?.SiteUrl]) {
      try { if (value) hosts.add(new URL(value).hostname.toLowerCase()); } catch { /* not an address */ }
    }
  }
  return hosts.size === 1 ? [...hosts][0] : null;
}

/**
 * Builds the frozen plan. `source` is a recorded `sharepoint-structure` collection
 * (loadWorkloadSource); `live` is the read run now (readSharePointStructure). `targets`
 * names resource keys; empty means every object in the backup.
 */
export function planSharePointStructureRestore({
  source, live, tenantId, tenantRef, targets = [], testTenantRefs = TEST_TENANT_REFS, allowTenantWide = false,
}) {
  if (!source?.collectionId) throw new TypeError('a SharePoint structure restore needs a recorded source collection');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('a SharePoint structure restore plan needs the tenant');
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  const named = new Set((targets ?? []).map(lc));
  const observations = (source.observations ?? [])
    .filter((item) => familyOf(item.resourceKey) && (!named.size || named.has(lc(item.resourceKey))))
    .sort((a, b) => FAMILY_ORDER.indexOf(familyOf(a.resourceKey)) - FAMILY_ORDER.indexOf(familyOf(b.resourceKey)) || a.resourceKey.localeCompare(b.resourceKey));
  for (const key of named) {
    if (!observations.some((item) => lc(item.resourceKey) === key)) throw new Error(`the backup holds no ${key}`);
  }
  const context = {
    source, live, tenantRef, testTenantRefs, allowTenantWide,
    manual: [], operations: [], refusals: [], effects: [], liveFingerprints: {},
  };
  const claimed = new Set();
  for (const observation of observations) {
    const family = familyOf(observation.resourceKey);
    const liveKey = family === 'siteTemplate' ? planSite(observation, context) : planObject(family, observation, context);
    if (liveKey) claimed.add(liveKey);
  }
  if (!named.size) {
    for (const entry of live?.resources ?? []) {
      if (claimed.has(entry.resourceKey) || entry.kind === 'siteTemplate') continue;
      context.manual.push({ resourceKey: entry.resourceKey, field: null, reason: 'it is newer than the backup; KEEL never deletes it' });
    }
  }
  const plan = {
    workload: SHAREPOINT_STRUCTURE_WORKLOAD,
    tenantId: tenantId.toLowerCase(),
    targets: observations.map((item) => item.resourceKey),
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations: context.operations,
    manual: context.manual,
    excluded: [],
    contentEffects: context.effects.sort((a, b) => `${a.naturalKey}|${a.field}`.localeCompare(`${b.naturalKey}|${b.field}`)),
    refusals: context.refusals,
    liveFingerprints: context.liveFingerprints,
    ...(allowTenantWide === true ? { allowTenantWide: true } : {}),
  };
  plan.digest = workloadSettingsPlanDigest(plan);
  return deepFreeze(plan);
}

/** The sites and host a live read needs for the site templates in a backup (or a plan). */
export function liveReadScope(source) {
  const sites = (source?.observations ?? []).filter((item) => familyOf(item.resourceKey) === 'siteTemplate').map((item) => item.fields?.url).filter(Boolean);
  return { sites, tenantHost: sourceTenantHost(source) };
}

/** Persists the plan as an immutable dry-run artifact (the shared workload artifact shape). */
export const createSharePointStructureRestoreArtifact = createWorkloadSettingsArtifact;

// ------------------------------------------------------------ execution

/**
 * Promotes one approved artifact. `read({ powershell, families, sites })` re-reads the
 * workload live; `qualifications` maps each write operationId to its qualification.
 * Plan outcomes: refused, no-change, disabled, blocked-content-effect, verified, partial.
 */
export async function executeSharePointStructureRestore(client, {
  tenantRef, artifactId, tenantId, read, powershell = {}, qualifications = {}, actor = null, testTenantRefs = TEST_TENANT_REFS,
}) {
  const workload = SHAREPOINT_STRUCTURE_WORKLOAD;
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: SHAREPOINT_STRUCTURE_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, operationId: `${workload}.restore`, outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return result;
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });
  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== workload) return refuse(`no ${workload} restore plan with this id`);
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (workloadSettingsPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (lc(tenantId) !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live structure already matches the backup'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await appendEvidence(client, {
      tenantRef, kind: SHAREPOINT_STRUCTURE_RESTORE_EVIDENCE_KIND,
      subject: {
        artifactId, operationId: op.operationId, kind: op.kind, target: op.resourceKey,
        outcome: full.outcome, writes: full.writes, attempts: full.attempts ?? full.writes, verified: full.verified, reasons: full.reasons, error: full.error ?? null,
      },
      actor: by,
    });
  };

  let runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }
  const affected = (op) => plan.contentEffects.some((effect) => effect.naturalKey === op.naturalKey);
  if (runnable.some(affected)) {
    try {
      await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
    } catch (error) {
      for (const op of runnable.filter(affected)) await settle(op, { outcome: 'blocked-content-effect', reasons: [error.message] });
      runnable = runnable.filter((op) => !affected(op));
    }
  }
  const readFor = (op) => read({ powershell, families: [op.family], sites: op.family === 'siteTemplate' ? [op.parameters.Url] : [] });
  const findNow = (op, live) => {
    if (op.family === 'siteTemplate') return resources(live, 'siteTemplate').find((item) => lc(item.fields?.url) === lc(op.parameters.Url)) ?? null;
    if (op.liveKey) return resources(live, op.family).find((item) => item.resourceKey === op.liveKey) ?? null;
    // An add: nothing with its title (or a hub on its site) may have appeared since the plan.
    return matchLive(op.family, { resourceKey: op.resourceKey, fields: op.family === 'hubSite' ? { SiteUrl: op.parameters.Site } : { Title: op.parameters.Title } }, live);
  };
  for (const op of runnable) {
    let live = null;
    try { live = await readFor(op); } catch { live = null; }
    const gap = !live || liveGap(live, op.family, op.family === 'siteTemplate' ? op.parameters.Url : null);
    const entry = gap ? undefined : findNow(op, live);
    const now = entry === undefined ? null : fingerprint(op.family, entry);
    if (now === null || now !== plan.liveFingerprints[op.resourceKey]) {
      await settle(op, { outcome: 'stale', reasons: [`the live ${op.family} changed since the dry run, or could not be re-read; a new dry run is required`] });
      continue;
    }
    // The fixture guard again, on what is read now and what is about to be written.
    const writing = { fields: op.family === 'siteTemplate' ? { url: op.parameters.Url } : op.family === 'hubSite' ? { SiteUrl: op.parameters.Site ?? op.parameters.Identity, Title: op.parameters.Title } : op.parameters };
    const notFixture = guard(op.family, [entry, writing], { key: op.resourceKey, tenantRef, testTenantRefs, allowTenantWide: plan.allowTenantWide === true });
    if (notFixture) {
      await settle(op, { outcome: 'refused', reasons: [notFixture] });
      continue;
    }
    await runOperation(op, { powershell, readFor, findAfter: (o, l) => findAfter(o, l), settle });
  }

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome = 'partial';
  for (const single of ['verified', 'disabled', 'blocked-content-effect']) if (outcomes.size === 1 && outcomes.has(single)) outcome = single;
  return finish({ outcome, operations, reasons: [] });
}

/** The object a write should have produced, read after it. */
function findAfter(op, live) {
  if (op.family === 'siteTemplate') return resources(live, 'siteTemplate').find((item) => lc(item.fields?.url) === lc(op.parameters.Url)) ?? null;
  if (op.kind === 'update') return resources(live, op.family).find((item) => item.resourceKey === op.liveKey) ?? null;
  return matchLive(op.family, { resourceKey: op.resourceKey, fields: op.family === 'hubSite' ? { SiteUrl: op.parameters.Site } : { Title: op.parameters.Title } }, live);
}

/** Which planned parts show in what was read back, and which do not. */
function readBack(op, entry) {
  const verified = [];
  const mismatched = [];
  if (op.family === 'siteTemplate') {
    const fields = entry.fields ?? {};
    const have = {
      lists: new Set((fields.lists ?? []).map((item) => lc(item.Url))),
      siteColumns: new Set((fields.siteColumns ?? []).map(columnKey)),
      contentTypes: new Set((fields.contentTypes ?? []).map(typeKey)),
    };
    for (const part of ['lists', 'siteColumns', 'contentTypes']) {
      if (!op.expect[part].length) continue;
      (op.expect[part].every((key) => have[part].has(key)) ? verified : mismatched).push(part);
    }
    if (op.expect.navigation) (same(fields.navigation ?? [], op.expect.navigation) ? verified : mismatched).push('navigation');
    return { verified, mismatched };
  }
  for (const { field, after } of op.changes) {
    (entry.fieldCoverage?.[field]?.status === 'observed' && readsBackAs(field, entry.fields?.[field], after) ? verified : mismatched).push(field);
  }
  return { verified, mismatched };
}

async function verify(op, { readFor, settle }, { ambiguous, cause }) {
  let entry = null;
  try {
    const live = await readFor(op);
    entry = liveGap(live, op.family, op.family === 'siteTemplate' ? op.parameters.Url : null) ? null : findAfter(op, live);
  } catch (error) {
    cause = cause ?? error.message;
  }
  if (!entry) {
    await settle(op, { outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts: 1, reasons: [`the write ${ambiguous ? `had an unknown outcome (${cause}) and was not resent;` : 'was sent, but'} the result could not be read back`] });
    return;
  }
  const { verified, mismatched } = readBack(op, entry);
  if (!mismatched.length) {
    await settle(op, {
      outcome: 'verified', writes: 1, attempts: 1, verified,
      reasons: ambiguous ? [`the write outcome was unknown (${cause}); the re-read shows it applied, so it was not resent`] : [],
    });
    return;
  }
  await settle(op, {
    outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts: 1, verified,
    reasons: ambiguous ? [`the write outcome was unknown (${cause}) and the re-read does not show it; it was not resent`] : mismatched.map((field) => `${field} did not read back as written`),
  });
}

async function runOperation(op, context) {
  try {
    await structureWriteCmdlet({ cmdlet: op.cmdlet, parameters: op.parameters }, context.powershell);
  } catch (error) {
    if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') {
      const failed = structuredFailure(error);
      await context.settle(op, {
        outcome: failed.status === 'denied' ? 'refused' : 'failed', writes: 1, attempts: 1,
        reasons: [`${op.cmdlet} failed: ${error.detail.message}; nothing is retried automatically`], error: failed.error,
      });
      return;
    }
    if (error instanceof SharePointStructureWriteScopeError || error instanceof SharePointStructureScopeError || error instanceof TypeError) {
      await context.settle(op, { outcome: 'refused', reasons: [error.message] });
      return;
    }
    // No answer (timeout, crash, malformed output): reconcile by reading, never resend.
    await verify(op, context, { ambiguous: true, cause: error.message });
    return;
  }
  await verify(op, context, { ambiguous: false, cause: null });
}

// ------------------------------------------------------------ dispatch entry

/** The live read a restore makes: only the families (and sites) it needs. */
export function structureReader(readImpl = readSharePointStructure) {
  return ({ powershell, families = ['hubSite', 'siteDesign', 'siteScript', 'siteTemplate'], sites = [] }) => {
    const hosts = [...new Set(sites.map((url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } }))];
    if (hosts.length > 1 || hosts.includes(null)) throw new Error('the sites to read are not on one SharePoint host');
    return readImpl({ powershell, families, sites, tenantHost: hosts[0] ?? null });
  };
}

/** The dispatch.mjs entry. */
export function sharePointStructureRestore({ readImpl = readSharePointStructure } = {}) {
  const read = structureReader(readImpl);
  return Object.freeze({
    label: 'SharePoint site structure',
    operations: SHAREPOINT_STRUCTURE_WRITE_OPS,
    usage: '--collection <id> [--target <key> ...]',
    async plan(client, { tenantRef, tenantId, request, connection }) {
      if (typeof request.collectionId !== 'string' || !request.collectionId) throw new Error('--collection <id> is required for this workload');
      const source = await loadWorkloadSource(client, { tenantRef, collectionId: request.collectionId, workload: SHAREPOINT_STRUCTURE_WORKLOAD });
      if (!source) throw new Error(`no recorded SharePoint site structure collection ${request.collectionId} for this tenant`);
      const { sites, tenantHost } = liveReadScope(source);
      if (sites.length && !tenantHost) throw new Error('the backed-up sites are not on one SharePoint host');
      if (request.tenantHost && tenantHost && lc(request.tenantHost) !== tenantHost) throw new Error(`the backup was taken from ${tenantHost}, not ${request.tenantHost}`);
      const live = await read({ powershell: connection.powershell, sites });
      return planSharePointStructureRestore({
        source, live, tenantId, tenantRef, targets: request.targets ?? [], allowTenantWide: request.allowTenantWide === true,
      });
    },
    create: createSharePointStructureRestoreArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications }) => executeSharePointStructureRestore(client, {
      tenantRef, artifactId, tenantId, read, powershell: connection.powershell, qualifications,
    }),
  });
}
