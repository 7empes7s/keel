/**
 * Task 48: tenant-scoped historical identity context for collection.
 *
 * canonicalize.mjs resolves Graph ids to natural keys from the current batch
 * alone; when a type is absent from a run (failed read, tier scoping) every
 * reference to its objects degrades to `unknown:<guid>`. This module persists
 * the (tenant, type, source id) -> natural key aliases evidenced by successful
 * per-type enumerations so a later run can resolve those references against
 * history instead.
 *
 * Rules enforced here:
 *  - Every row is qualified by tenant_ref; no read or write path can observe
 *    or mutate another tenant's aliases.
 *  - Only successful type outcomes (complete / complete-empty) create or
 *    refresh aliases; failed/partial reads prove nothing and change nothing.
 *  - Only a successful FULL per-type enumeration may tombstone ids it did not
 *    observe. Failed, partial and not-requested outcomes never tombstone. A
 *    complete-empty enumeration observed zero live ids, so it tombstones
 *    every previously live alias of that type — the loop below runs once per
 *    successful coverageDigest entry regardless of whether any resource of
 *    that type was present in this batch.
 *  - The current batch always overrides persistent context: a fresh
 *    observation updates the alias (rename) and clears any tombstone.
 *  - Seeding reads preexisting snapshots' stored rows and only ever INSERTs
 *    missing aliases — historical resource_version keys are never rewritten.
 *
 * The context is read-side identity resolution only. It is never evidence for
 * authorizing writes: callers receive staleness provenance (recorded by
 * canonicalize.mjs on the resource provenance, separate from semantic hashes)
 * so any consumer can distinguish a current observation from a historical one.
 */
import { CONTEXT_EXCLUDED_TYPES } from '../cir/canonicalize.mjs';

// Source ids are normalized to lowercase at the only two write paths
// (recordSymbolContext, seedSymbolContext) because canonicalize.mjs always
// looks the context up with `guid.toLowerCase()` (both for roleAssignment's
// composed-key resolveSymbol and for reference resolution in buildResource).
// Real Graph responses are not guaranteed to use consistent letter casing for
// the same GUID across endpoints/runs; storing anything but the lowercase
// form here would silently desync from every lookup site and degrade a
// resolvable historical id to unknown:<guid>.
function sourceIdFor(resourceType, sourceId) {
  if (CONTEXT_EXCLUDED_TYPES.has(resourceType)) return null;
  return typeof sourceId === 'string' && sourceId.length > 0 ? sourceId.toLowerCase() : null;
}

/**
 * Load the live (non-tombstoned) aliases for one tenant as the fallback
 * context canonicalizeAll() expects: Map<lowercase source id, { symbol, type }>.
 */
export async function loadSymbolContext(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT resource_type, source_id, natural_key
       FROM resource_symbol
      WHERE tenant_ref = $1 AND tombstoned_at IS NULL`,
    [tenantRef],
  );
  const context = new Map();
  for (const row of rows) {
    context.set(row.source_id, { symbol: row.natural_key, type: row.resource_type });
  }
  return context;
}

function isSuccessfulOutcome(entry) {
  return entry?.outcome === 'complete' || entry?.outcome === 'complete-empty';
}

/**
 * Persist the aliases a snapshot run evidenced. `resources` are the full
 * canonicalization result (all successfully read types, before any tier
 * storage filter) and `coverageDigest` the adapter's real per-type outcomes,
 * so every tier updates context while tier-excluded types in the stored
 * snapshot keep their not-requested marker. A complete-empty enumeration
 * observes zero live ids and therefore tombstones every previously live id
 * of that type.
 */
export async function recordSymbolContext(client, { tenantRef, snapshotId, resources, coverageDigest, observedAt = new Date() }) {
  const observedByType = new Map();
  for (const resource of resources) {
    const sourceId = sourceIdFor(resource.resourceType, resource.sourceId);
    if (!sourceId) continue;
    if (!observedByType.has(resource.resourceType)) observedByType.set(resource.resourceType, []);
    observedByType.get(resource.resourceType).push({ sourceId, naturalKey: resource.naturalKey });
  }

  let upserted = 0;
  let tombstoned = 0;
  for (const [type, aliases] of observedByType) {
    if (!isSuccessfulOutcome(coverageDigest?.[type])) continue;
    for (const { sourceId, naturalKey } of aliases) {
      // Current batch overrides persistent context: a rename updates the key,
      // a re-observed tombstoned id comes back live.
      await client.query(
        `INSERT INTO resource_symbol
           (tenant_ref, resource_type, source_id, natural_key, first_seen_at, last_seen_at, source_snapshot, tombstoned_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, NULL)
         ON CONFLICT (tenant_ref, resource_type, source_id) DO UPDATE
           SET natural_key = EXCLUDED.natural_key,
               last_seen_at = EXCLUDED.last_seen_at,
               source_snapshot = EXCLUDED.source_snapshot,
               tombstoned_at = NULL`,
        [tenantRef, type, sourceId, naturalKey, observedAt, snapshotId],
      );
      upserted += 1;
    }
  }

  // Iterate coverageDigest (the adapter's real per-type outcomes), not
  // observedByType: a complete-empty type has no entry in observedByType at
  // all (zero resources were built for it), but its successful full
  // enumeration is exactly the case that must tombstone every alias the
  // tenant previously had for that type. Skipping types absent from
  // observedByType here would leave those aliases live forever.
  for (const [type, entry] of Object.entries(coverageDigest ?? {})) {
    if (!isSuccessfulOutcome(entry)) continue;
    const observed = (observedByType.get(type) ?? []).map((alias) => alias.sourceId);
    const result = await client.query(
      `UPDATE resource_symbol
          SET tombstoned_at = $4
        WHERE tenant_ref = $1 AND resource_type = $2 AND tombstoned_at IS NULL
          AND NOT (source_id = ANY($3))`,
      [tenantRef, type, observed, observedAt],
    );
    tombstoned += result.rowCount;
  }
  return { upserted, tombstoned };
}

/**
 * Seed the context from preexisting successful snapshots, newest first so the
 * latest observed identity per type wins. Inserts only missing aliases
 * (ON CONFLICT DO NOTHING) and never touches resource_version rows — the
 * stored historical keys stay exactly as collected. Legacy bare-count digest
 * entries count as successful observations only when the count is nonzero
 * (a legacy zero cannot prove an empty read).
 */
export async function seedSymbolContext(client, { tenantRef }) {
  const { rows: snapshots } = await client.query(
    `SELECT id, completed_at, coverage_digest
       FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, started_at DESC, id DESC`,
    [tenantRef],
  );
  const coveredTypes = new Set();
  let seeded = 0;
  for (const snap of snapshots) {
    const digest = snap.coverage_digest ?? {};
    for (const [type, entry] of Object.entries(digest)) {
      if (coveredTypes.has(type)) continue;
      const successful = isSuccessfulOutcome(entry)
        || (typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0);
      if (!successful) continue;
      coveredTypes.add(type);
      const { rows: versions } = await client.query(
        `SELECT natural_key, payload FROM resource_version
          WHERE snapshot_id = $1 AND resource_type = $2`,
        [snap.id, type],
      );
      for (const version of versions) {
        const sourceId = sourceIdFor(type, version.payload?.id);
        if (!sourceId) continue;
        const result = await client.query(
          `INSERT INTO resource_symbol
             (tenant_ref, resource_type, source_id, natural_key, first_seen_at, last_seen_at, source_snapshot)
           VALUES ($1, $2, $3, $4, $5, $5, $6)
           ON CONFLICT (tenant_ref, resource_type, source_id) DO NOTHING`,
          [tenantRef, type, sourceId, version.natural_key, snap.completed_at, snap.id],
        );
        seeded += result.rowCount;
      }
    }
  }
  return { seeded };
}
