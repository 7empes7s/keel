import { sameContent } from '../cir/canonicalHash.mjs';
import { acceptDrift } from './baseline.mjs';
import { recordDisposition } from '../store/governance.mjs';
import { refuseSameContentDrift, refuseSameContentDriftIds } from '../store/openDrift.mjs';
import { DispositionApprovalError, assertDispositionApproval, driftNeedsReview, ignoreExpiry } from './dispositionReview.mjs';

/** Spec M2.6.3. Ignore suppression keys on (naturalKey, afterHash) — never naturalKey alone. */
export function isSuppressed(drift, dispositions, now) {
  return dispositions.some((disposition) => {
    const dispositionDrift = disposition.drift ?? disposition;
    const expiresAt = disposition.expiresAt ?? disposition.expires_at;
    const naturalKey = dispositionDrift.naturalKey ?? dispositionDrift.natural_key;

    return disposition.action === 'ignore'
      && expiresAt != null
      && new Date(expiresAt) > now
      && naturalKey === (drift.naturalKey ?? drift.natural_key)
      && sameAfter(dispositionDrift, drift);
  });
}

// The ignored change and this one end in the same content. A hash stored under older
// field rules is checked again from the payloads (cir/canonicalHash.mjs sameContent),
// so an ignore recorded before a rule change still covers the same content.
function sameAfter(ignored, drift) {
  const side = (row) => ({ payload_hash: row.afterHash ?? row.after_hash ?? null, payload: row.afterPayload ?? row.after_payload ?? null });
  const resourceType = drift.resourceType ?? drift.resource_type ?? ignored.resourceType ?? ignored.resource_type;
  return sameContent(side(ignored), side(drift), resourceType);
}

/** Whether accepting or ignoring this drift row needs a second person
 * (dispositionReview.mjs). An unknown row is left to the caller's own not-found path. */
export async function dispositionNeedsReview(client, { driftId }) {
  const { rows: [drift] } = await client.query(
    'SELECT resource_type, blast_radius FROM drift WHERE id::text = $1',
    [String(driftId)],
  );
  if (!drift) return false;
  return driftNeedsReview({ resourceType: drift.resource_type, blastRadius: drift.blast_radius });
}

// Audit run 2, finding 3: accept and ignore of a sign-in or admin-access change run only
// under an approval a second person gave for exactly this decision (`approvalId`). An
// ignore always ends within MAX_IGNORE_DAYS. `now` is for tests.
export async function applyDisposition(client, {
  driftId, action, actor, reason, expiresAt, approvalId = null, now = new Date(),
}) {
  if (action === 'accept' || action === 'ignore') {
    const until = action === 'ignore' ? ignoreExpiry(expiresAt, now) : null;
    // A row that records no change is refused first: there is nothing to decide.
    await refuseSameContentDriftIds(client, [driftId]);
    if (await dispositionNeedsReview(client, { driftId })) {
      const approval = await assertDispositionApproval(client, {
        approvalId,
        actor,
        matches: (params) => Array.isArray(params.driftIds) && params.driftIds.length === 1
          && String(params.driftIds[0]) === String(driftId) && params.action === action
          && (action !== 'ignore' || new Date(params.expiresAt).valueOf() === until.valueOf()),
      });
      // An approval is used once: a change decided since it was asked for is never
      // decided again under it (a replay would put an older version back into the
      // approved setup). An older decision, such as an ignore that ran out, does not count.
      const { rows: decided } = await client.query(
        'SELECT 1 FROM disposition WHERE drift_id::text = $1 AND decided_at >= $2 LIMIT 1',
        [String(driftId), approval.created_at],
      );
      if (decided.length) throw new DispositionApprovalError('this change was already decided; the approval is used');
    }
    if (action === 'accept') return acceptDrift(client, { driftId, actor, reason });
    return recordDisposition(client, { driftId, action, actor, reason, expiresAt: until });
  }

  if (action === 'rollback') {
    const { buildRollbackPlan } = await import('./rollbackPlan.mjs');
    const { rows: driftRows } = await client.query(
      'SELECT * FROM drift WHERE id = $1',
      [driftId],
    );
    if (!driftRows[0]) throw new Error(`drift not found: ${driftId}`);
    refuseSameContentDrift(driftRows);

    const { rows: baselineRows } = await client.query(
      `SELECT br.natural_key, rv.resource_type, rv.payload, rv.payload_hash, rv.hash_version,
              rv.blast_radius
       FROM baseline_resource br
       JOIN resource_version rv ON rv.id = br.resource_version_id
       WHERE br.baseline_id = $1`,
      [driftRows[0].baseline_id],
    );
    return buildRollbackPlan(driftRows, baselineRows);
  }

  throw new Error(`unknown disposition action: ${action}`);
}
