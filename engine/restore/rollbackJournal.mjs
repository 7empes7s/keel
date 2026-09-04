/** Spec §9.4 — every write records the prior state before mutation; any wave
 * can be reversed. Rollback is itself a plan, subject to the same safety
 * gates (enforced by whatever calls buildRollbackPlan's output back through
 * applyWave — this module only produces the plan, it never applies it). */
export async function recordPriorState(client, { runId, naturalKey, priorState }) {
  await client.query(
    `INSERT INTO rollback_entry (run_id, natural_key, prior_state) VALUES ($1,$2,$3)`,
    [runId, naturalKey, priorState],
  );
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
