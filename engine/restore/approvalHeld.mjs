/**
 * Kinds that were held back for a privilege review and are now written behind the
 * restore approval: who may join devices, the default rules for app secrets and
 * certificates, and custom Intune admin roles (APPROVAL_HELD_FIELDS in
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
  const { effects } = classifyContentEffects([{ ...resource, verb }]);
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
