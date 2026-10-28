/**
 * The undo of a restore that created an Intune policy which is assigned now
 * (decided 2026-10-28): the person planning the undo chooses to delete the
 * policy with its assignments, or to skip it (compensation.mjs
 * applyUndoChoices). This reads, with the collector (read only), which
 * planned undos are of a policy that is assigned now, and to whom.
 */
import { undoAssignmentsPath } from './intuneOperations.mjs';

const TARGET_KINDS = Object.freeze({
  allDevicesAssignmentTarget: 'all-devices',
  allLicensedUsersAssignmentTarget: 'all-users',
  groupAssignmentTarget: 'group',
  exclusionGroupAssignmentTarget: 'excluded-group',
});

/** Who one assignment applies to, in a form the portal words: a kind, and the group id when it names one. */
export function assignmentTarget(assignment) {
  const target = assignment?.target ?? {};
  const type = String(target['@odata.type'] ?? '').replace(/^#?microsoft\.graph\./, '');
  const kind = TARGET_KINDS[type] ?? 'other';
  return { kind, ...(typeof target.groupId === 'string' && target.groupId.length > 0 ? { groupId: target.groupId } : {}) };
}

/**
 * Map naturalKey -> { ids, targets } for each planned undo of a created
 * policy that has assignments now. A policy whose assignments cannot be read
 * here is left as planned: the delete itself reads them again and never
 * deletes an assigned policy without a choice.
 */
export async function readUndoAssignments(reader, operations) {
  const assigned = new Map();
  for (const op of operations ?? []) {
    if (op?.verb !== 'delete' || op.undoes !== 'create') continue;
    const route = undoAssignmentsPath(op.resourceType, op.live?.payload ?? null, op.targetId);
    if (!route) continue;
    const read = await reader.get(route.version, route.path);
    const items = read?.ok === true && !read.body?.['@odata.nextLink'] ? read.body?.value : null;
    if (!Array.isArray(items) || items.length === 0) continue;
    assigned.set(op.naturalKey, {
      ids: items.map((item) => String(item?.id ?? '')),
      targets: items.map(assignmentTarget),
    });
  }
  return assigned;
}
