import { acceptDrift } from './baseline.mjs';
import { recordDisposition } from '../store/governance.mjs';

/** Spec M2.6.3. Ignore suppression keys on (naturalKey, afterHash) — never naturalKey alone. */
export function isSuppressed(drift, dispositions, now) {
  return dispositions.some((disposition) => {
    const dispositionDrift = disposition.drift ?? disposition;
    const expiresAt = disposition.expiresAt ?? disposition.expires_at;
    const naturalKey = dispositionDrift.naturalKey ?? dispositionDrift.natural_key;
    const afterHash = dispositionDrift.afterHash ?? dispositionDrift.after_hash;

    return disposition.action === 'ignore'
      && expiresAt != null
      && new Date(expiresAt) > now
      && naturalKey === (drift.naturalKey ?? drift.natural_key)
      && afterHash === (drift.afterHash ?? drift.after_hash);
  });
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
    return recordDisposition(client, { driftId, action, actor, reason, expiresAt });
  }

  if (action === 'rollback') {
    const { buildRollbackPlan } = await import('./rollbackPlan.mjs');
    const { rows: driftRows } = await client.query(
      'SELECT * FROM drift WHERE id = $1',
      [driftId],
    );
    if (!driftRows[0]) throw new Error(`drift not found: ${driftId}`);

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
