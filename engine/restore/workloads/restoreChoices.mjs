/**
 * What the Restore page offers for one workload backup: every object it holds, grouped
 * by kind, with whether KEEL can put it back and how it differs from the newest backup.
 *
 * Only workloads whose dry run needs nothing but the backup and the chosen objects are
 * offered (PAGE_RESTORE_WORKLOADS). SharePoint settings, one mailbox and one team still
 * take operator input (a tenant host, a mailbox, a team) and stay with the operator.
 *
 * Pure: the caller loads the observations (loadWorkloadSource). Nothing here decides
 * what is written; the dry run plans that again from the live tenant.
 */
import { WORKLOAD_DESCRIPTORS } from '../../collect/workloadContract.mjs';
import { MANUAL_FAMILIES, WKLD_WRITE_OPERATIONS } from './writeDeclarations.mjs';
import { workloadTarget, writeFamilies } from './cmdletSettings.mjs';

export const PURVIEW_LABELS_WORKLOAD = 'purview-labels';

/** The workloads a person can start a restore for from the Restore page. */
export const PAGE_RESTORE_WORKLOADS = Object.freeze([
  'exchange-mail-flow', 'exchange-extended', 'teams-org-policies', 'teams-voice-policies',
  'purview-retention-dlp', 'purview-governance', PURVIEW_LABELS_WORKLOAD,
]);

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

/** The name a person knows an object by; never a key or a Guid when a name exists. */
function nameOf(observation) {
  const fields = observation.fields ?? {};
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
  const families = writeFamilies(workload);
  const ops = families[kind];
  if (ops?.update) {
    const declaration = WKLD_WRITE_OPERATIONS[ops.update];
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
export function workloadChoices(workload, observations, newest = null) {
  if (!PAGE_RESTORE_WORKLOADS.includes(workload)) throw new Error(`the Restore page does not start a restore for ${workload}`);
  const later = newest ? new Map(newest.map((item) => [item.resourceKey, item])) : null;
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
    const newer = later ? later.get(observation.resourceKey) ?? null : null;
    const change = !later ? null : !newer ? 'deleted' : canonical(newer.fields) === canonical(observation.fields) ? 'same' : 'changed';
    let restorable = spec.update;
    let reason = null;
    if (restorable && change === 'deleted' && !spec.add) {
      restorable = false;
      reason = 'Deleted since this backup. KEEL does not add this back; an admin makes it again by hand from the backup.';
    }
    const tenantWide = spec.declaration ? workloadTarget(spec.declaration, kind, observation).tenantWide : false;
    groups.get(kind).items.push({
      key: observation.resourceKey, name: nameOf(observation) ?? spec.name, change, restorable, reason, tenantWide,
    });
  }
  const order = { changed: 0, deleted: 1, same: 2 };
  return [...groups.values()]
    .map((group) => ({ ...group, items: group.items.sort((a, b) => (order[a.change] ?? 3) - (order[b.change] ?? 3) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => Number(b.restorable) - Number(a.restorable) || a.name.localeCompare(b.name));
}
