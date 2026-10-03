/** Spec §9.4 — every write records the prior state before mutation; any wave
 * can be reversed. Rollback is itself a plan, subject to the same safety
 * gates (enforced by whatever calls buildRollbackPlan's output back through
 * applyWave — this module only produces the plan, it never applies it).
 *
 * Roadmap task-70: the journal is also the inverse-instruction record behind
 * conflict-aware compensation (engine/restore/compensation.mjs). Before a write
 * it records what the write is and what it intends; after, what was observed and
 * whether it succeeded, was rejected, or is uncertain. The extra fields are all
 * optional, so every existing caller keeps writing exactly the rows it did. */
export async function recordPriorState(client, {
  runId, naturalKey, priorState,
  restoreRef = null, resourceType = null, operation = null, targetId = null, blastRadius = null,
  intendedState = undefined,
}) {
  const journaled = restoreRef !== null || operation !== null;
  if (!journaled) {
    // The pre-task-70 row, unchanged — for callers that journal prior state only.
    await client.query(
      `INSERT INTO rollback_entry (run_id, natural_key, prior_state) VALUES ($1,$2,$3)`,
      [runId, naturalKey, priorState],
    );
    return null;
  }
  const result = await client.query(
    `INSERT INTO rollback_entry
       (run_id, natural_key, prior_state, restore_ref, resource_type, operation, target_id, blast_radius,
        intended_state, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      runId, naturalKey, priorState, restoreRef, resourceType, operation, targetId, blastRadius,
      intendedState === undefined ? null : JSON.stringify(intendedState),
      'pending',
    ],
  );
  return result?.rows?.[0]?.id ?? null;
}

/** Task-70: how a single Graph write ended, from its result alone.
 *  - 'succeeded': the write returned ok (the caller still downgrades a write
 *    that does not verify to 'uncertain').
 *  - 'failed': Graph answered with a definite rejection (a 4xx other than 408
 *    and 429), so the write did not happen.
 *  - 'uncertain': no response (lost, timed out, thrown), a 5xx, a 408, or a 429
 *    left after retries. The write may have landed; only a fresh read decides. */
export function classifyWriteOutcome(result) {
  if (result?.ok === true) return 'succeeded';
  const status = Number(result?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'failed';
  return 'uncertain';
}

export const WRITE_OUTCOMES = Object.freeze(['pending', 'succeeded', 'failed', 'uncertain']);

export async function recordWriteOutcome(client, { entryId, outcome, postState = undefined, targetId = undefined, detail = null }) {
  if (!entryId) return;
  if (!WRITE_OUTCOMES.includes(outcome) || outcome === 'pending') throw new Error(`invalid write outcome: ${outcome}`);
  await client.query(
    `UPDATE rollback_entry
        SET outcome = $2,
            post_state = COALESCE($3::jsonb, post_state),
            target_id = COALESCE($4, target_id),
            outcome_detail = $5,
            outcome_at = now()
      WHERE id = $1`,
    [entryId, outcome, postState === undefined ? null : JSON.stringify(postState), targetId ?? null, detail],
  );
}

/** Task-70: the journal of one promoted run, in write order. Entries written
 * before task-70 carry no restore_ref and are never returned here. */
export async function listJournal(client, { restoreRef }) {
  const { rows } = await client.query(
    `SELECT id, run_id, natural_key, prior_state, restore_ref, resource_type, operation, target_id, blast_radius,
            intended_state, post_state, outcome, outcome_detail, recorded_at
       FROM rollback_entry
      WHERE restore_ref = $1
      ORDER BY recorded_at, id`,
    [restoreRef],
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    naturalKey: row.natural_key,
    priorState: row.prior_state ?? null,
    restoreRef: row.restore_ref,
    resourceType: row.resource_type,
    operation: row.operation,
    targetId: row.target_id ?? null,
    blastRadius: row.blast_radius ?? null,
    intendedState: row.intended_state ?? null,
    postState: row.post_state ?? null,
    outcome: row.outcome ?? 'pending',
    outcomeDetail: row.outcome_detail ?? null,
    recordedAt: row.recorded_at,
  }));
}

export async function buildRollbackPlan(client, { runId }) {
  const { rows } = await client.query(
    `SELECT natural_key, prior_state FROM rollback_entry WHERE run_id = $1 ORDER BY recorded_at DESC`,
    [runId],
  );
  return rows.map((r) => ({
    naturalKey: r.natural_key,
    action: r.prior_state === null ? 'delete' : 'restore-prior',
    priorState: r.prior_state,
  }));
}
