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

const EDGE_RESOURCE_TYPE = {
  member: 'groupMembership', owner: 'groupOwnership', transitiveMember: 'groupTransitiveMembership',
  appOwner: 'applicationOwnership', servicePrincipalOwner: 'servicePrincipalOwnership',
  appRoleGrant: 'appRoleGrant', assignment: 'policyAssignment',
};

// Order-insensitive comparison of an edge's attributes (assignment filter,
// intent, settings digest). Null and absent attributes are the same.
function attributesKey(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(attributesKey).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${attributesKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Task 57: edge drift, independent of parent payload drift. `baseline` and
 * `observed` are loadRelationshipState() results (engine/collect/
 * relationships.mjs). A membership-only change surfaces here even when the
 * parent resource's own hash is unchanged.
 *
 * Only a CURRENT observed edge set is authority for an 'added'/'removed'
 * entry. A stale/unknown observed set (the newest child read failed or was
 * partial) never produces removals — it is reported in `unverified` with the
 * original failure, so a failed read can never be mistaken for an emptied
 * group. A baseline with no targets (never read completely) likewise cannot
 * anchor a comparison. States from two different tenants are refused.
 * Transitive drift is flagged `derived: true`: it is an expansion result, not
 * a direct edge a write could remove.
 */
export function diffRelationships(baseline, observed) {
  if (baseline.tenantRef !== observed.tenantRef) {
    throw new Error('cannot diff relationship state across tenants');
  }
  const drift = [];
  const unverified = [];
  for (const [key, after] of observed.entries) {
    const before = baseline.entries.get(key);
    if (after.failure?.outcome === 'unsupported') {
      // No registered read for this parent type: never a comparison, never drift.
      unverified.push({ key, family: after.family, parentSourceId: after.parentSourceId, reason: 'unsupported-relationship', failure: after.failure });
      continue;
    }
    if (!before || before.targets === null) {
      unverified.push({ key, family: after.family, parentSourceId: after.parentSourceId, reason: 'no-baseline' });
      continue;
    }
    if (after.state !== 'current') {
      unverified.push({
        key, family: after.family, parentSourceId: after.parentSourceId,
        reason: after.state === 'stale' ? 'stale-child-read' : 'child-read-never-complete',
        failure: after.failure, lastKnownAt: after.observedAt,
      });
      continue;
    }
    // Edge identity is edgeKey (falls back to targetId for rows written before
    // task 58); a same-key edge whose attributes differ is 'modified'.
    const identity = (t) => t.edgeKey ?? t.targetId;
    const beforeIds = new Map(before.targets.map((t) => [identity(t), t]));
    const afterIds = new Map(after.targets.map((t) => [identity(t), t]));
    const emit = (changeType, target, previous = null) => drift.push({
      naturalKey: `edge:${after.edgeType}:${after.parentSourceId}:${identity(target)}`,
      resourceType: EDGE_RESOURCE_TYPE[after.family] ?? `edge:${after.family}`,
      changeType,
      beforeHash: changeType === 'added' ? null : identity(target) + (previous ? `#${attributesKey(previous.attributes)}` : ''),
      afterHash: changeType === 'removed' ? null : identity(target) + (previous ? `#${attributesKey(target.attributes)}` : ''),
      ...(changeType === 'modified' ? { beforeAttributes: previous.attributes ?? null, afterAttributes: target.attributes ?? null } : {}),
      blastRadius: 'access-affecting',
      parentSourceId: after.parentSourceId,
      parentNaturalKey: after.parentNaturalKey,
      edgeType: after.edgeType,
      targetId: target.targetId,
      targetNaturalKey: target.targetNaturalKey ?? null,
      derived: after.direction === 'transitive',
    });
    for (const [id, target] of afterIds) {
      const previous = beforeIds.get(id);
      if (!previous) emit('added', target);
      else if (attributesKey(previous.attributes) !== attributesKey(target.attributes)) emit('modified', target, previous);
    }
    for (const [id, target] of beforeIds) if (!afterIds.has(id)) emit('removed', target);
  }
  return { drift, unverified };
}
