import { collectWithOutcomes } from './entraAdapter.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion, insertReferences } from '../store/db.mjs';
import { loadSymbolContext, recordSymbolContext, seedSymbolContext } from '../store/resourceSymbols.mjs';
import { collectRelationships, recordRelationships, parentTypesForFamilies, DEFAULT_RELATIONSHIP_FAMILIES } from './relationships.mjs';
import { brandingLocales, collectBrandingAssets, organizationIdOf } from './brandingAssets.mjs';
import { recordBrandingAssets } from '../store/brandingAssets.mjs';

/** Group ids (lowercase) named in any collected Conditional Access policy's user conditions. */
export function conditionalAccessGroupIds(canonical) {
  const ids = new Set();
  for (const resource of canonical ?? []) {
    if (resource.resourceType !== 'conditionalAccessPolicy') continue;
    const users = resource.payload?.conditions?.users ?? {};
    for (const list of [users.excludeGroups, users.includeGroups]) {
      if (!Array.isArray(list)) continue;
      for (const id of list) if (typeof id === 'string' && id.length > 0) ids.add(id.toLowerCase());
    }
  }
  return [...ids].sort();
}

/** Persist outcomes independently of resources, including completed empty reads. */
export async function collectSnapshot(client, { reader, tenantRef, tenantId, tier, relationships = false, brandingAssets = false }) {
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
  let relationshipsByFamily = null;
  if (relationships) {
    const families = relationships?.families ?? DEFAULT_RELATIONSHIP_FAMILIES;
    // Parents are the collected resources whose type a requested family applies
    // to; `parentTypes` names extra types to request explicitly (a type with no
    // registered read is recorded `unsupported`, never read generically).
    const parentTypes = parentTypesForFamilies(families);
    for (const extra of relationships?.parentTypes ?? []) parentTypes.add(extra);
    const parents = canonical
      .filter((resource) => parentTypes.has(resource.resourceType) && resource.sourceId)
      // The subtype routes an app protection policy's assignments (issue #155).
      .map((resource) => ({
        type: resource.resourceType, sourceId: resource.sourceId, naturalKey: resource.naturalKey,
        subtype: resource.payload?.['@odata.type'] ?? null,
      }));
    const observations = await collectRelationships(reader, { tenantRef, parents, families });
    // Gap D5: a group named in a Conditional Access policy's user conditions also
    // gets a read-only transitive membership read, so break-glass readiness can
    // prove an account is (or is not) excluded through a nested group. Only those
    // groups are read; the derived set is kept apart from direct membership.
    if (relationships?.conditionalAccessTransitive && !families.includes('transitiveMember')) {
      const groupsById = new Map(canonical
        .filter((resource) => resource.resourceType === 'group' && resource.sourceId)
        .map((resource) => [String(resource.sourceId).toLowerCase(), resource]));
      const transitiveParents = conditionalAccessGroupIds(canonical).map((id) => ({
        type: 'group', sourceId: id, naturalKey: groupsById.get(id)?.naturalKey ?? null,
      }));
      observations.push(...await collectRelationships(reader, { tenantRef, parents: transitiveParents, families: ['transitiveMember'] }));
    }
    const targetContext = await loadSymbolContext(client, { tenantRef });
    await recordRelationships(client, { snapshotId, tenantRef, observations, context: targetContext });
    relationshipSummary = observations.reduce((acc, obs) => {
      acc[obs.outcome] = (acc[obs.outcome] ?? 0) + 1;
      return acc;
    }, {});
    // The same counts per family, so a caller can report each kind of read
    // (policy assignments, group members and owners, nested membership) on its own.
    relationshipsByFamily = observations.reduce((acc, obs) => {
      const counts = (acc[obs.family] ??= {});
      counts[obs.outcome] = (counts[obs.outcome] ?? 0) + 1;
      return acc;
    }, {});
  }
  // Gap register M6: the company branding files (images, favicon, custom
  // stylesheet) of every locale this snapshot holds, read beside it and stored
  // by content hash. Opt-in, like relationships. A file read never changes a
  // type's outcome; each file keeps its own (present, absent, too-large, failed).
  let brandingAssetSummary = null;
  if (brandingAssets) {
    const locales = brandingLocales(result.collected);
    // The files are read under the directory id of this run's organization
    // object; without one (the type was not collected) nothing is read.
    const organizationId = organizationIdOf(result.collected);
    if (locales.length > 0 && organizationId && typeof reader?.getStream === 'function') {
      const observations = await collectBrandingAssets(reader, { organizationId, locales });
      brandingAssetSummary = await recordBrandingAssets(client, { snapshotId, tenantRef, observations });
    }
  }
  return {
    snapshotId,
    coverageDigest: result.coverageDigest,
    ...(relationshipSummary ? { relationships: relationshipSummary, relationshipsByFamily } : {}),
    ...(brandingAssetSummary ? { brandingAssets: brandingAssetSummary } : {}),
  };
}
