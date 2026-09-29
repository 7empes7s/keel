/** Spec M2.6.2. Pure diff of a materialized baseline against an observed snapshot,
 * keyed by natural key. Refuses to compare differing hash_versions (spec M2.3).
 *
 * Task 50: `lineageOf(row)` is an optional caller-supplied lookup (backed by
 * engine/store/resourceLineage.mjs, resolved through any evidenced recovery
 * chain) returning the row's lineage id, or a falsy value when unknown. When
 * supplied, a natural key that disappeared and a DIFFERENT natural key that
 * appeared are collapsed into a single 'modified' (renamed) entry ONLY when
 * both resolve to the SAME lineage id — same source-id rename, or an
 * evidenced recovery link. Two rows with no lineage information, or with
 * different lineage ids, are never merged: unrelated name reuse always stays
 * a plain removed+added pair, never a false continuity. Symmetrically, when
 * the SAME natural key is present on both sides but resolves to two
 * DIFFERENT lineage ids (the name was freed and reused by an unrelated
 * resource within this diff window), it is split into a removed+added pair
 * instead of one misleading 'modified' entry — a coincidental name match is
 * never treated as one resource's continuous history. */
export function diffSnapshots(baselineRows, observedRows, { lineageOf } = {}) {
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
  const consumed = new Set();

  if (typeof lineageOf === 'function') {
    const removedCandidates = [...naturalKeys].filter(
      (key) => baselineByNaturalKey.has(key) && !observedByNaturalKey.has(key),
    );
    const addedCandidates = [...naturalKeys].filter(
      (key) => !baselineByNaturalKey.has(key) && observedByNaturalKey.has(key),
    );
    for (const removedKey of removedCandidates) {
      const before = baselineByNaturalKey.get(removedKey);
      const beforeLineage = lineageOf(before);
      if (!beforeLineage) continue;
      const matchedKey = addedCandidates.find((addedKey) => {
        if (consumed.has(addedKey)) return false;
        return lineageOf(observedByNaturalKey.get(addedKey)) === beforeLineage;
      });
      if (!matchedKey) continue;
      const after = observedByNaturalKey.get(matchedKey);
      if (before.hash_version !== after.hash_version) {
        throw new Error(
          `cannot compare hash versions for ${matchedKey}: ${before.hash_version} vs ${after.hash_version}`,
        );
      }
      drift.push({
        naturalKey: matchedKey,
        resourceType: after.resource_type,
        changeType: 'modified',
        beforeHash: before.payload_hash,
        afterHash: after.payload_hash,
        blastRadius: after.blast_radius,
        renamedFrom: removedKey,
        lineageId: beforeLineage,
      });
      consumed.add(removedKey);
      consumed.add(matchedKey);
    }
  }

  for (const naturalKey of naturalKeys) {
    if (consumed.has(naturalKey)) continue;
    const before = baselineByNaturalKey.get(naturalKey);
    const after = observedByNaturalKey.get(naturalKey);

    if (before && after && before.hash_version !== after.hash_version) {
      throw new Error(
        `cannot compare hash versions for ${naturalKey}: ${before.hash_version} vs ${after.hash_version}`,
      );
    }

    if (before && after && typeof lineageOf === 'function') {
      const beforeLineage = lineageOf(before);
      const afterLineage = lineageOf(after);
      if (beforeLineage && afterLineage && beforeLineage !== afterLineage) {
        drift.push({
          naturalKey, resourceType: before.resource_type, changeType: 'removed',
          beforeHash: before.payload_hash, afterHash: null, blastRadius: before.blast_radius,
        });
        drift.push({
          naturalKey, resourceType: after.resource_type, changeType: 'added',
          beforeHash: null, afterHash: after.payload_hash, blastRadius: after.blast_radius,
        });
        continue;
      }
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
