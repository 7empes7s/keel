/**
 * Kinds that were held back for a privilege review and are now written behind the
 * restore approval: who may join devices, the default rules for app secrets and
 * certificates, custom Intune admin roles, who holds Intune, Exchange and Defender
 * admin roles, and Intune multi admin approval policies (APPROVAL_HELD_FIELDS in
 * safety/contentEffects.mjs).
 *
 * A change to any field that decides access is an 'access-changing' content
 * effect. The dry run lists it, and the promotion checks its approval
 * (assertContentEffectApproval), which the customer's restore approval setting
 * may waive for the service. Either way the promotion hands the effects it
 * checked to the writers as `approvedContentEffects`. An enforce write is made
 * only when every effect it carries is one of those, exactly (same object, field,
 * before and after), so a write the reviewed dry run did not show is refused.
 */
import { APPROVAL_HELD_FIELDS, classifyContentEffects } from '../safety/contentEffects.mjs';
import { outcomeDetail, sameValue, undoesCreate } from './recordWriter.mjs';

export const APPROVAL_HELD_KINDS = Object.freeze(Object.keys(APPROVAL_HELD_FIELDS));
const LIVE_STATES = new Set(['present', 'soft-deleted']);

const sameEffect = (approved, effect) => approved?.effect === effect.effect
  && approved.resourceType === effect.resourceType
  && approved.naturalKey === effect.naturalKey
  && approved.field === effect.field
  && JSON.stringify(approved.before ?? null) === JSON.stringify(effect.before ?? null)
  && JSON.stringify(approved.after ?? null) === JSON.stringify(effect.after ?? null);

/** The access-changing effects of this write that the promotion did not approve. */
export function unapprovedAccessEffects(resource, verb, approvedContentEffects = []) {
  // A writer that rewrote the backup's ids to the target's (a role assignment's
  // members) keeps the backup as `backupPayload`: the effects are judged on it, as
  // the dry run judged them, and name each principal (contentEffects.mjs).
  const payload = resource.backupPayload ?? resource.payload;
  const { effects } = classifyContentEffects([{ ...resource, payload, verb }]);
  return effects.filter((effect) => effect.effect === 'access-changing'
    && !(approvedContentEffects ?? []).some((approved) => sameEffect(approved, effect)));
}

/**
 * A record `refusal` for an approval-held kind: null when the write may go ahead,
 * else a manual step. A dry run is never refused: it plans the write and lists the
 * effects for review. A delete carries no access effect here (the only delete is
 * the undo of a role this restore created, which takes access away).
 */
export function approvalHeldRefusal(resource, verb, ctx = {}) {
  if (verb === 'delete' || ctx.mode === 'dry-run') return null;
  // An update is classified against the live object; without one nothing shows what
  // it changes, so it is never written here.
  if (verb === 'update' && !LIVE_STATES.has(resource.live?.state)) {
    return Object.freeze({ outcome: 'failed', reason: `${resource.resourceType}: an update of a setting that decides access needs the live object read first, and it was not` });
  }
  const open = unapprovedAccessEffects(resource, verb, ctx.approvedContentEffects);
  if (open.length === 0) return null;
  const fields = [...new Set(open.map((effect) => effect.field))];
  const description = `This changes admin access (${fields.join(', ')}), so it is written only once the restore's dry run is approved. `
    + 'Run the restore as a dry run, have someone other than you approve "Changes admin access" in Approvals, then run it again. '
    + 'If restore approvals are turned off for this service, running the reviewed dry run again writes it.';
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: ${description}`,
    completion: Object.freeze([Object.freeze({ kind: 'manual-setting', requirement: 'accessApproval', fields: Object.freeze(fields), description })]),
  });
}

/** A record refusal that runs `own` first, then the approval gate. */
export const withApprovalGate = (own = null) => (resource, verb, ctx) => (own ? own(resource, verb, ctx) : null)
  ?? approvalHeldRefusal(resource, verb, ctx);

// ------------------------------------------------ batch 2: who holds admin roles
//
// Intune, Exchange and Defender role assignments and Intune multi admin approval
// policies. Each names users, groups or apps by id. Their records rewrite those
// ids to the target's (`remapsReferences`: a group found by its name, a user by
// sign-in name, an app by app id, a role this run recreated), and the approval
// effects name them (contentEffects.mjs namedAccessValue).

/** A record's `sameField` for lists of ids, compared as sets (Graph keeps no order). */
export const sameIdLists = (fields) => (field, desired, live) => {
  if (!fields.includes(field)) return null;
  const ids = (value) => (Array.isArray(value) ? value.map((id) => String(id).toLowerCase()).sort() : value ?? null);
  return sameValue(ids(desired), ids(live));
};

/**
 * A record `refusal` that lets a delete through only as the undo of an object this
 * restore created (compensation). `where` tells a person where to delete it.
 */
export const undoOnlyDelete = (what, where) => (resource, verb) => (verb !== 'delete' || undoesCreate(resource) ? null : Object.freeze({
  outcome: 'skipped',
  reason: `manual: a restore deletes only ${what} it created itself (when that restore is undone); delete it by hand in ${where}`,
}));

/** Every row of a list, across pages: { value } or { error }. */
export async function readAllPages(io, version, path, { maxPages = 50 } = {}) {
  const value = [];
  let next = path;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await io.retryOperation(() => io.writer.read(version, next));
    if (result?.ok !== true) return { error: outcomeDetail(result) };
    value.push(...(result.body?.value ?? []));
    next = result.body?.['@odata.nextLink'];
    if (typeof next !== 'string' || next.length === 0) return { value };
  }
  return { error: `more than ${maxPages} pages` };
}

/**
 * A record `preflight` for a kind Graph gives a new id on every create, so a
 * second restore from the same backup would not know the first one's object.
 * Before a create, the target's list is read: an object `matches` the backup
 * (same name, or same principal and role) and holds the same access (`same`)
 * means the create is done; a match with other access is left for a person,
 * never duplicated. `payload` is the backup with the target's ids.
 */
export const createdOnce = ({ version, path, label, matches, same }) => async (io, { payload, verb }) => {
  if (verb !== 'create') return null;
  const listed = await readAllPages(io, version, path);
  if (listed.error) return `could not list the ${label}s to look for one made before (${listed.error})`;
  const found = listed.value.filter((row) => matches(row, payload));
  if (found.length === 0) return null;
  const done = found.find((row) => same(row, payload));
  if (done) return { skipped: `the ${label} is already there with the backup's access (${done.id}), so nothing is written` };
  return `a ${label} like this one already exists with other access; KEEL does not make a second one, so check it by hand`;
};
