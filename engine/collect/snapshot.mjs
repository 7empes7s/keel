import { collectWithOutcomes } from './entraAdapter.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion, insertReferences } from '../store/db.mjs';
import { loadSymbolContext, recordSymbolContext, seedSymbolContext } from '../store/resourceSymbols.mjs';
import { collectRelationships, recordRelationships, parentTypesForFamilies, DEFAULT_RELATIONSHIP_FAMILIES } from './relationships.mjs';

/** Persist outcomes independently of resources, including completed empty reads. */
export async function collectSnapshot(client, { reader, tenantRef, tenantId, tier, relationships = false }) {
  // Tier selection (task 49) happens inside collectWithOutcomes, before any
  // HTTP read: an excluded type's endpoint is never called, so `collected`
  // below already holds only the requested tier's types (or every type when
  // tier is unset) and result.coverageDigest already carries the
  // not-requested marker for everything this run did not fetch.
  const result = await collectWithOutcomes(reader, { tenantId, tier });
  // Tenant-scoped historical identity context (task-48): resolve references
  // and composed keys for types absent from this run against the aliases
  // evidenced by earlier successful enumerations. On the first run after the
  // context table exists, seed it from preexisting successful snapshots —
  // inserts only, historical keys are never rewritten. A tenant with no
  // successful history simply has no context; those ids stay unresolved.
  let context = await loadSymbolContext(client, { tenantRef });
  if (context.size === 0) {
    await seedSymbolContext(client, { tenantRef });
    context = await loadSymbolContext(client, { tenantRef });
  }
  // Current batch overrides persistent context — including absence: a type
  // this run fully enumerated (complete or complete-empty) is authoritative,
  // so its historical aliases must not resolve ids the fresh enumeration did
  // not return (the matching tombstones are written by recordSymbolContext
  // below). Without complete-empty here, a genuinely emptied type would still
  // resolve stale ids from history within this same run.
  const fullyEnumerated = new Set(Object.entries(result.coverageDigest)
    .filter(([, entry]) => entry?.outcome === 'complete' || entry?.outcome === 'complete-empty')
    .map(([type]) => type));
  if (fullyEnumerated.size > 0 && context.size > 0) {
    context = new Map([...context].filter(([, alias]) => !fullyEnumerated.has(alias.type)));
  }
  const canonical = canonicalizeAll(result.collected, { context });
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const resource of canonical) {
    const versionId = await insertResourceVersion(client, {
      snapshotId, resource: { ...resource, fidelity: resource.provenance.fidelity },
    });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  // "complete" means the run finished; coverageDigest carries per-type success.
  // Storage/canonicalization errors still abort without a completed snapshot.
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: result.coverageDigest });
  // Context is recorded from this run's canonicalization and the adapter's
  // real outcomes: only types this run actually fetched can be 'complete' or
  // 'complete-empty', so a tier-excluded type's historical aliases are left
  // untouched here (neither refreshed nor tombstoned) rather than fetched to
  // service its own context update.
  await recordSymbolContext(client, {
    tenantRef, snapshotId, resources: canonical, coverageDigest: result.coverageDigest,
  });
  // Relationship (edge) observations (task-57) are separate child reads per
  // group, recorded beside — never inside — the type digest, so a failed edge
  // read cannot alter a type's own outcome. Opt-in: `relationships: true`, or
  // { families: [...] }. Only groups from a successfully enumerated type are
  // read, and each parent x family keeps its own outcome.
  let relationshipSummary = null;
  if (relationships) {
    const families = relationships?.families ?? DEFAULT_RELATIONSHIP_FAMILIES;
    // Parents are the collected resources whose type a requested family applies
    // to; `parentTypes` names extra types to request explicitly (a type with no
    // registered read is recorded `unsupported`, never read generically).
    const parentTypes = parentTypesForFamilies(families);
    for (const extra of relationships?.parentTypes ?? []) parentTypes.add(extra);
    const parents = canonical
      .filter((resource) => parentTypes.has(resource.resourceType) && resource.sourceId)
      .map((resource) => ({ type: resource.resourceType, sourceId: resource.sourceId, naturalKey: resource.naturalKey }));
    const observations = await collectRelationships(reader, { tenantRef, parents, families });
    const targetContext = await loadSymbolContext(client, { tenantRef });
    await recordRelationships(client, { snapshotId, tenantRef, observations, context: targetContext });
    relationshipSummary = observations.reduce((acc, obs) => {
      acc[obs.outcome] = (acc[obs.outcome] ?? 0) + 1;
      return acc;
    }, {});
  }
  return { snapshotId, coverageDigest: result.coverageDigest, ...(relationshipSummary ? { relationships: relationshipSummary } : {}) };
}
