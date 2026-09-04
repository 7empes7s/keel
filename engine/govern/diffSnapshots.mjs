/** Spec M2.6.2. Pure diff of a materialized baseline against an observed snapshot,
 * keyed by natural key. Refuses to compare differing hash_versions (spec M2.3). */
export function diffSnapshots(baselineRows, observedRows) {
  const baselineByNaturalKey = new Map(
    baselineRows.map((row) => [row.natural_key, row]),
  );
  const observedByNaturalKey = new Map(
    observedRows.map((row) => [row.natural_key, row]),
  );
  const naturalKeys = new Set([
    ...baselineByNaturalKey.keys(),
    ...observedByNaturalKey.keys(),
  ]);
  const drift = [];

  for (const naturalKey of naturalKeys) {
    const before = baselineByNaturalKey.get(naturalKey);
    const after = observedByNaturalKey.get(naturalKey);

    if (before && after && before.hash_version !== after.hash_version) {
      throw new Error(
        `cannot compare hash versions for ${naturalKey}: ${before.hash_version} vs ${after.hash_version}`,
      );
    }

    if (before && !after) {
      drift.push({
        naturalKey,
        resourceType: before.resource_type,
        changeType: 'removed',
        beforeHash: before.payload_hash,
        afterHash: null,
        blastRadius: before.blast_radius,
      });
    } else if (!before && after) {
      drift.push({
        naturalKey,
        resourceType: after.resource_type,
        changeType: 'added',
        beforeHash: null,
        afterHash: after.payload_hash,
        blastRadius: after.blast_radius,
      });
    } else if (before.payload_hash !== after.payload_hash) {
      drift.push({
        naturalKey,
        resourceType: after.resource_type,
        changeType: 'modified',
        beforeHash: before.payload_hash,
        afterHash: after.payload_hash,
        blastRadius: after.blast_radius,
      });
    }
  }

  return drift;
}
