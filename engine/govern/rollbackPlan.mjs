/** Spec M2.6.3. Turns selected drift rows into a scoped same-tenant restore plan whose
 * desired state is the baseline, executed by the Phase B verb path. */
export function buildRollbackPlan(driftRows, baselineRows) {
  const baselineByNaturalKey = new Map(
    baselineRows.map((row) => [row.natural_key, row]),
  );
  const resources = [];
  const expectedVerbs = new Map();

  for (const drift of driftRows) {
    const baseline = baselineByNaturalKey.get(drift.natural_key);

    if (drift.change_type === 'modified') {
      resources.push({
        naturalKey: drift.natural_key,
        resourceType: drift.resource_type,
        payload: baseline.payload,
        blastRadius: drift.blast_radius,
      });
      expectedVerbs.set(drift.natural_key, 'update');
    }

    if (drift.change_type === 'added') {
      resources.push({
        naturalKey: drift.natural_key,
        resourceType: drift.resource_type,
        payload: null,
        blastRadius: drift.blast_radius,
      });
      expectedVerbs.set(drift.natural_key, 'delete');
    }

    if (drift.change_type === 'removed') {
      resources.push({
        naturalKey: drift.natural_key,
        resourceType: drift.resource_type,
        payload: baseline.payload,
        blastRadius: drift.blast_radius,
      });
      expectedVerbs.set(drift.natural_key, 'create|restore-soft-deleted');
    }
  }

  return { resources, expectedVerbs };
}
