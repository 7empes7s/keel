/**
 * What the Restore page offers for one workload backup: every object it holds, grouped
 * by kind, with whether KEEL can put it back and how it differs from the newest backup.
 *
 * Policy workloads plan every chosen object in one dry run. Mailboxes and teams
 * (PER_ITEM_WORKLOADS) plan one object per dry run, so the page starts one check per
 * chosen mailbox or team. SharePoint site structure (hub sites, site designs, site
 * scripts and named sites' lists and navigation) plans like a policy workload, from its
 * own write declarations. SharePoint settings still take operator input (a tenant host
 * and a site) and stay with the operator.
 *
 * Pure: the caller loads the observations (loadWorkloadSource). Nothing here decides
 * what is written; the dry run plans that again from the live tenant.
 */
import { WORKLOAD_DESCRIPTORS } from '../../collect/workloadContract.mjs';
import { MANUAL_FAMILIES, WKLD_WRITE_OPERATIONS } from './writeDeclarations.mjs';
import { workloadTarget, writeFamilies } from './cmdletSettings.mjs';
import { EXCHANGE_WORKLOAD } from '../../collect/workloads/exchange.mjs';
import { TEAMS_WORKLOAD } from '../../collect/workloads/teams.mjs';
import { SHAREPOINT_STRUCTURE_WORKLOAD } from '../../collect/workloads/sharepointStructure.mjs';
import { SHAREPOINT_STRUCTURE_WRITE_OPERATIONS } from './sharepointStructureWrites.mjs';
import { structureTarget } from './sharepointStructure.mjs';

export const PURVIEW_LABELS_WORKLOAD = 'purview-labels';

/**
 * Workloads whose dry run covers one mailbox or one team. `prefix` marks the objects
 * a person picks; `organization` is the one tenant-wide object, planned together with
 * a mailbox (`--include-organization`), never on its own.
 */
export const PER_ITEM_WORKLOADS = Object.freeze({
  [EXCHANGE_WORKLOAD]: Object.freeze({ prefix: 'mailbox:', kind: 'mailbox', name: 'Mailboxes', organization: 'organization' }),
  [TEAMS_WORKLOAD]: Object.freeze({ prefix: 'team:', kind: 'team', name: 'Teams', organization: null }),
});

/** The CLI request fields for one chosen object of a per-item workload. */
export function perItemRequest(workload, key) {
  const spec = PER_ITEM_WORKLOADS[workload];
  if (!spec || typeof key !== 'string' || !key.startsWith(spec.prefix) || key.length === spec.prefix.length) return null;
  const value = key.slice(spec.prefix.length);
  return workload === EXCHANGE_WORKLOAD ? { mailbox: value } : { teamId: value };
}

/** The workloads a person can start a restore for from the Restore page. */
export const PAGE_RESTORE_WORKLOADS = Object.freeze([
  EXCHANGE_WORKLOAD, TEAMS_WORKLOAD,
  'exchange-mail-flow', 'exchange-extended', 'teams-org-policies', 'teams-voice-policies',
  'purview-retention-dlp', 'purview-governance', PURVIEW_LABELS_WORKLOAD,
  SHAREPOINT_STRUCTURE_WORKLOAD,
]);

// Every write the page plans: the cmdlet workloads' and SharePoint structure's (PnP).
const PAGE_DECLARATIONS = Object.freeze({ ...WKLD_WRITE_OPERATIONS, ...SHAREPOINT_STRUCTURE_WRITE_OPERATIONS });

// A site's template is stored for a restore, not compared: PnP rewrites it on every
// export, so a change shows in its summaries (lists, columns, content types, navigation).
const NOT_COMPARED = Object.freeze({
  [SHAREPOINT_STRUCTURE_WORKLOAD]: Object.freeze(['templateXml', 'templateSha256', 'templateBytes']),
});

const PURVIEW_KINDS = Object.freeze({
  label: { prefix: 'label:', read: 'purview.label-definitions' },
  labelPolicy: { prefix: 'label-policy:', read: 'purview.label-publication' },
});

const resourceOf = (readId) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === readId)?.resource ?? null;

/** "meetingPolicy" -> "Meeting policies"; only when no descriptor names the kind. */
function plainKind(kind) {
  const words = String(kind).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const plural = words.endsWith('y') ? `${words.slice(0, -1)}ies` : words.endsWith('s') ? words : `${words}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

/** A site's path, "/sites/finance", or the address when it is not one. */
function sitePath(url) {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { return url ?? null; }
}

/** The name a person knows an object by; never a key or a Guid when a name exists. */
function nameOf(observation, workload = null) {
  const fields = observation.fields ?? {};
  if (workload === SHAREPOINT_STRUCTURE_WORKLOAD) {
    // A hub, design or script by its title; a site by its title and path, as two sites can share a title.
    const title = [fields.Title, fields.title].find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
    const path = sitePath(fields.url ?? null);
    if (path && title) return `${title} (${path})`;
    if (title || path) return title ?? path;
  }
  for (const field of ['DisplayName', 'displayName', 'Name', 'name']) {
    if (typeof fields[field] === 'string' && fields[field].trim()) return fields[field].trim();
  }
  const identity = String(fields.Identity ?? observation.identity ?? '');
  if (/^global$/i.test(identity)) return 'Global (everyone)';
  if (/^tag:/i.test(identity)) return identity.replace(/^tag:/i, '');
  return identity || null;
}

function kindOf(workload, observation) {
  if (workload !== PURVIEW_LABELS_WORKLOAD) return observation.kind ?? null;
  return observation.resourceKey.startsWith(PURVIEW_KINDS.labelPolicy.prefix) ? 'labelPolicy' : 'label';
}

/** What KEEL does for one kind: { name, update, add, manual } (manual: why a person does it). */
function kindSpec(workload, kind) {
  if (workload === PURVIEW_LABELS_WORKLOAD) {
    const spec = PURVIEW_KINDS[kind];
    return spec ? { name: resourceOf(spec.read) ?? plainKind(kind), update: true, add: false, manual: null, declaration: null } : null;
  }
  const families = writeFamilies(workload, PAGE_DECLARATIONS);
  const ops = families[kind];
  if (ops?.update) {
    const declaration = PAGE_DECLARATIONS[ops.update];
    return { name: resourceOf(declaration.readBack) ?? plainKind(kind), update: true, add: Boolean(ops.add), manual: null, declaration };
  }
  const manual = MANUAL_FAMILIES[workload]?.[kind] ?? null;
  return { name: plainKind(kind), update: false, add: false, manual, declaration: null };
}

/**
 * `observations` are the chosen backup's; `newest` the newest backup's, or null when
 * the chosen one is the newest. Each item: { key, name, change, restorable, reason,
 * tenantWide }, where change is 'changed', 'deleted' or 'same' against the newest
 * backup (null when there is nothing newer).
 */
const compared = (fields, skip) => (skip ? Object.fromEntries(Object.entries(fields ?? {}).filter(([field]) => !skip.includes(field))) : fields);
const changeOf = (later, observation, skip = null) => {
  if (!later) return null;
  const newer = later.get(observation.resourceKey) ?? null;
  return !newer ? 'deleted' : canonical(compared(newer.fields, skip)) === canonical(compared(observation.fields, skip)) ? 'same' : 'changed';
};

/** Whether writing this object reaches the whole tenant (the fixture guard's view). */
function tenantWideOf(workload, spec, kind, observation) {
  if (!spec.declaration) return false;
  if (workload === SHAREPOINT_STRUCTURE_WORKLOAD) return structureTarget(kind, [observation]).tenantWide;
  return workloadTarget(spec.declaration, kind, observation).tenantWide;
}
const CHANGE_ORDER = { changed: 0, deleted: 1, same: 2 };
const byChange = (a, b) => (CHANGE_ORDER[a.change] ?? 3) - (CHANGE_ORDER[b.change] ?? 3) || a.name.localeCompare(b.name);

/** Mailboxes or teams: one group of the objects a person picks, plus Exchange's organization. */
function perItemChoices(workload, observations, later) {
  const spec = PER_ITEM_WORKLOADS[workload];
  const items = [];
  let organization = null;
  for (const observation of observations) {
    const key = observation.resourceKey;
    if (spec.organization && key === spec.organization) {
      organization = {
        // The organization is always there; a newer backup that skipped it says nothing.
        key, name: 'Organization-wide Exchange settings', change: changeOf(later, observation) === 'deleted' ? null : changeOf(later, observation), restorable: true,
        reason: 'Put back together with a mailbox: tick at least one mailbox too.', tenantWide: true,
      };
      continue;
    }
    if (!key.startsWith(spec.prefix)) continue;
    const change = changeOf(later, observation);
    // A deleted mailbox or team is not made again by KEEL; the dry run needs it live.
    const restorable = change !== 'deleted';
    items.push({
      key, name: nameOf(observation) ?? key.slice(spec.prefix.length), change, restorable,
      reason: restorable ? null : `Deleted since this backup. KEEL does not make ${spec.kind === 'team' ? 'a team' : 'a mailbox'} again; an admin restores it first.`,
      tenantWide: false,
    });
  }
  const groups = [];
  if (items.length) groups.push({ kind: spec.kind, name: spec.name, restorable: true, reason: null, items: items.sort(byChange) });
  if (organization) groups.push({ kind: 'organization', name: 'Organization', restorable: true, reason: null, items: [organization] });
  return groups;
}

export function workloadChoices(workload, observations, newest = null) {
  if (!PAGE_RESTORE_WORKLOADS.includes(workload)) throw new Error(`the Restore page does not start a restore for ${workload}`);
  const later = newest ? new Map(newest.map((item) => [item.resourceKey, item])) : null;
  if (PER_ITEM_WORKLOADS[workload]) return perItemChoices(workload, observations, later);
  const groups = new Map();
  for (const observation of observations) {
    const kind = kindOf(workload, observation);
    if (!kind) continue;
    const spec = kindSpec(workload, kind);
    if (!spec) continue;
    if (!groups.has(kind)) {
      groups.set(kind, {
        kind, name: spec.name, restorable: spec.update,
        reason: spec.update ? null : spec.manual ?? 'KEEL does not put this kind of setting back; an admin changes it by hand from the backup.',
        items: [],
      });
    }
    const change = changeOf(later, observation, NOT_COMPARED[workload] ?? null);
    let restorable = spec.update;
    let reason = null;
    if (restorable && change === 'deleted' && !spec.add) {
      restorable = false;
      reason = 'Deleted since this backup. KEEL does not add this back; an admin makes it again by hand from the backup.';
    }
    const tenantWide = tenantWideOf(workload, spec, kind, observation);
    groups.get(kind).items.push({
      key: observation.resourceKey, name: nameOf(observation, workload) ?? spec.name, change, restorable, reason, tenantWide,
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, items: group.items.sort(byChange) }))
    .sort((a, b) => Number(b.restorable) - Number(a.restorable) || a.name.localeCompare(b.name));
}
