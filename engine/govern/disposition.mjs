import { sameContent } from '../cir/canonicalHash.mjs';
import { acceptDrift } from './baseline.mjs';
import { recordDisposition } from '../store/governance.mjs';
import { refuseSameContentDrift, refuseSameContentDriftIds } from '../store/openDrift.mjs';

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

export async function applyDisposition(client, {
  driftId, action, actor, reason, expiresAt,
}) {
  if (action === 'accept') {
    return acceptDrift(client, { driftId, actor, reason });
  }

  if (action === 'ignore') {
    if (expiresAt == null) {
      throw new Error('ignore disposition requires expiresAt');
    }
    await refuseSameContentDriftIds(client, [driftId]);
    return recordDisposition(client, { driftId, action, actor, reason, expiresAt });
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
