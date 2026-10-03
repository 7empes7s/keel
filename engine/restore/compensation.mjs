// engine/restore/compensation.mjs
//
// Roadmap task-70: conflict-aware compensation for a failed restore. Given the
// inverse-instruction journal of ONE promoted run (rollbackJournal.mjs) and a
// fresh read of the target, plan the writes that undo what that run actually
// did — and nothing else:
//
//  - Only writes that landed are undone. A write Graph rejected did nothing. A
//    write whose response was lost (or that did not verify, or never recorded an
//    outcome) is reconciled by comparing the live object with what was intended
//    and what was there before; if that cannot decide, it is a conflict, never a
//    guess in either direction.
//  - An object changed again after this run wrote it (a later, legitimate admin
//    change) is a conflict: compensation refuses it rather than overwrite. An
//    update is undone field by field, only for the fields this run changed, so
//    an unrelated later change to another field is kept as it is.
//  - What cannot be undone stays explicit: a deleted object is not recreated
//    here (that is a new id — a forward restore's job), relationship edges are
//    manual, and content deleted or disclosed while a setting applied is not
//    brought back by restoring the setting.
//  - Compensation is not atomic. Each inverse write is its own Graph call,
//    verified and journaled like any other; a partial compensation is possible
//    and is itself compensable.
//
// The plan is executed only by promoting an immutable compensation dry-run
// artifact (cli/keel-restore.mjs), through the same capability gate, impact
// assessment, approval, fingerprint check and applyWave verification path as a
// forward restore. This module only plans; it never writes.
import { canonicalize } from '../cir/canonicalHash.mjs';
import { writableProjection } from '../reconcile/writableProjection.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

export const COMPENSATION_STATEMENT = 'Compensation is not atomic: each inverse write is a separate, verified Graph call, and only writes this restore actually made are undone. It never restores erased or disclosed content.';

function stable(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writableKeys(payload, resourceType) {
  if (!payload || typeof payload !== 'object') return [];
  return Object.keys(writableProjection(payload, resourceType) ?? {});
}

function fieldOf(payload, field, resourceType) {
  if (!payload || typeof payload !== 'object') return null;
  return canonicalize({ [field]: payload[field] }, resourceType)[field] ?? null;
}

function sameField(left, right, field, resourceType) {
  return stable(fieldOf(left, field, resourceType)) === stable(fieldOf(right, field, resourceType));
}

/** The writable fields whose value differs between two states of one object. */
export function changedFields(before, after, resourceType) {
  const fields = new Set([...writableKeys(before, resourceType), ...writableKeys(after, resourceType)]);
  return [...fields].filter((field) => !sameField(before, after, field, resourceType)).sort();
}

function differingFields(live, expected, fields, resourceType) {
  return fields.filter((field) => !sameField(live, expected, field, resourceType));
}

/** Task-70: decide whether an uncertain or interrupted write landed, from the
 * live object alone. 'landed' | 'not-landed' | 'unknown' — never assumed. */
export function reconcileUncertainWrite(entry, live) {
  const type = entry.resourceType;
  const present = live != null;
  const matches = (expected) => expected != null && present
    && differingFields(live.payload, expected, writableKeys(expected, type), type).length === 0;
  switch (entry.operation) {
    case 'create':
    case 'restore-soft-deleted':
      if (!present) return 'not-landed';
      if (entry.targetId && live.targetId && entry.targetId !== live.targetId) return 'unknown';
      return matches(entry.intendedState) || matches(entry.postState) ? 'landed' : 'unknown';
    case 'update': {
      if (!present) return 'unknown';
      const fields = changedFields(entry.priorState, entry.intendedState, type);
      if (fields.length === 0) return 'not-landed';
      if (differingFields(live.payload, entry.intendedState, fields, type).length === 0) return 'landed';
      if (differingFields(live.payload, entry.priorState, fields, type).length === 0) return 'not-landed';
      return 'unknown';
    }
    case 'delete':
      if (!present) return 'landed';
      return entry.targetId && live.targetId === entry.targetId ? 'not-landed' : 'unknown';
    default:
      return 'unknown';
  }
}

function forwardVerb(operation) {
  return operation === 'restore-soft-deleted' ? 'update' : operation;
}

/** Plan the compensation of one promoted run.
 * @param entries   listJournal() rows of that run, in write order.
 * @param current   Map naturalKey -> { targetId, payload } of objects present in
 *                  the target NOW (a fresh read, never the dry run's).
 */
export function planCompensation({ restoreRef, entries, current }) {
  const operations = [];
  const conflicts = [];
  const irrecoverable = [];
  const manual = [];
  const notApplied = [];
  const reconciled = [];

  const byKey = new Map();
  for (const entry of entries) {
    if (!byKey.has(entry.naturalKey)) byKey.set(entry.naturalKey, []);
    byKey.get(entry.naturalKey).push(entry);
  }
  // Undo in reverse write order: what was written last is undone first.
  const keys = [...byKey.keys()].reverse();

  for (const naturalKey of keys) {
    const list = byKey.get(naturalKey);
    const first = list[0];
    const last = list[list.length - 1];
    const entryIds = list.map((entry) => entry.id);
    const resourceType = last.resourceType;

    if (first.priorState?.kind === 'relationship-edge') {
      manual.push({ naturalKey, entryIds, reason: 'relationship edge: membership compensation is not a qualified operation — review this edge by hand' });
      continue;
    }
    if (!last.operation || !resourceType) {
      manual.push({ naturalKey, entryIds, reason: 'journal entry predates operation journaling; its outcome and intent are unknown' });
      continue;
    }

    // The state before this run is the FIRST entry's prior state; what the run
    // intended and observed is the LAST entry's.
    const entry = { ...last, priorState: first.priorState };
    const live = current.get(naturalKey) ?? null;

    let post;
    if (entry.outcome === 'failed') {
      notApplied.push({ naturalKey, entryIds, reason: `Graph rejected this write (${entry.outcomeDetail ?? 'rejected'}); nothing to undo` });
      continue;
    }
    if (entry.outcome === 'succeeded') {
      post = entry.operation === 'delete' ? null : (entry.postState ?? entry.intendedState);
    } else {
      // 'uncertain' or still 'pending': a lost response is never assumed to have failed.
      const finding = reconcileUncertainWrite(entry, live);
      reconciled.push({ naturalKey, outcome: entry.outcome, finding });
      if (finding === 'not-landed') {
        notApplied.push({ naturalKey, entryIds, reason: `outcome was ${entry.outcome}; a fresh read shows the write did not land — nothing to undo` });
        continue;
      }
      if (finding === 'unknown') {
        conflicts.push({ naturalKey, entryIds, reason: `uncertain-outcome: the ${entry.operation} had an ${entry.outcome} outcome and the live object matches neither what was intended nor what was there before — compensation will not guess` });
        continue;
      }
      post = entry.operation === 'delete' ? null : live.payload;
    }

    // Content consequences of the FORWARD write are not undone by reversing it.
    const forward = classifyContentEffects([{
      naturalKey,
      resourceType,
      verb: forwardVerb(entry.operation),
      payload: post,
      live: entry.priorState ? { state: 'present', payload: entry.priorState } : null,
    }]);
    for (const effect of forward.effects) {
      irrecoverable.push({ naturalKey, effect: effect.effect, field: effect.field, reason: effect.disclosure });
    }

    if (entry.operation === 'delete') {
      irrecoverable.push({
        naturalKey,
        effect: 'object-deleted',
        field: '(object deleted)',
        reason: `This restore deleted ${naturalKey}. Compensation does not recreate it: a recreated object gets a new id. Recover it with a forward restore — a native soft-delete restore keeps the id while the object is still in deleted items.`,
      });
      continue;
    }

    if (!live) {
      if (entry.operation === 'update') {
        conflicts.push({ naturalKey, entryIds, reason: 'concurrent-change: the object this restore updated is no longer present' });
      } else {
        notApplied.push({ naturalKey, entryIds, reason: 'already absent: nothing to undo' });
      }
      continue;
    }
    if (entry.targetId && live.targetId !== entry.targetId) {
      conflicts.push({ naturalKey, entryIds, reason: `concurrent-change: ${naturalKey} is now held by a different object (${live.targetId}, not ${entry.targetId})` });
      continue;
    }

    const liveState = { state: 'present', targetId: live.targetId, payload: live.payload };
    if (entry.operation === 'create' || entry.operation === 'restore-soft-deleted') {
      const changedSince = differingFields(live.payload, post, writableKeys(post, resourceType), resourceType);
      if (changedSince.length > 0) {
        conflicts.push({ naturalKey, entryIds, fields: changedSince, reason: `concurrent-change: ${changedSince.join(', ')} changed after this restore wrote the object — compensation will not overwrite a later change` });
        continue;
      }
      operations.push({
        naturalKey,
        resourceType,
        verb: 'delete',
        payload: null,
        targetId: live.targetId,
        blastRadius: entry.blastRadius,
        live: liveState,
        references: [],
        compensates: entryIds,
        undoes: entry.operation,
      });
      continue;
    }

    // update: undo only the fields this run changed, and only if they still hold
    // what this run wrote.
    // The fields this run set out to change (its intent), not whatever else the
    // object holds now — an unrelated later change is never reverted.
    const fields = changedFields(entry.priorState, entry.intendedState ?? post, resourceType);
    if (fields.length === 0) {
      notApplied.push({ naturalKey, entryIds, reason: 'the update changed no writable field; nothing to undo' });
      continue;
    }
    const changedSince = differingFields(live.payload, post, fields, resourceType);
    if (changedSince.length > 0) {
      conflicts.push({ naturalKey, entryIds, fields: changedSince, reason: `concurrent-change: ${changedSince.join(', ')} changed after this restore wrote it — compensation will not overwrite a later change` });
      continue;
    }
    const desired = { ...live.payload };
    for (const field of fields) {
      desired[field] = entry.priorState?.[field] ?? null;
    }
    operations.push({
      naturalKey,
      resourceType,
      verb: 'update',
      payload: desired,
      targetId: live.targetId,
      blastRadius: entry.blastRadius,
      live: liveState,
      references: [],
      compensates: entryIds,
      undoes: 'update',
      revertedFields: fields,
    });
  }

  return {
    compensates: restoreRef,
    atomic: false,
    statement: COMPENSATION_STATEMENT,
    operations,
    conflicts,
    irrecoverable,
    manual,
    notApplied,
    reconciled,
  };
}

/** The part of a compensation plan an approval binds: folded into the plan
 * digest, so any change to it after review refuses promotion. */
export function compensationDigestInput(plan) {
  return {
    compensates: plan.compensates,
    operations: plan.operations.map((op) => ({
      naturalKey: op.naturalKey, resourceType: op.resourceType, verb: op.verb, targetId: op.targetId,
      payload: op.payload, compensates: op.compensates, revertedFields: op.revertedFields ?? null,
    })),
    conflicts: plan.conflicts.map((c) => ({ naturalKey: c.naturalKey, reason: c.reason })),
    irrecoverable: plan.irrecoverable.map((i) => ({ naturalKey: i.naturalKey, effect: i.effect, field: i.field })),
    manual: plan.manual.map((m) => m.naturalKey),
  };
}
