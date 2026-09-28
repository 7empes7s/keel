import { collectWithOutcomes } from './entraAdapter.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion, insertReferences } from '../store/db.mjs';
import { loadSymbolContext, recordSymbolContext, seedSymbolContext } from '../store/resourceSymbols.mjs';

/** Persist outcomes independently of resources, including completed empty reads. */
export async function collectSnapshot(client, { reader, tenantRef, tenantId, tier }) {
  const result = await collectWithOutcomes(reader, { tenantId });
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
  const resources = canonical.filter((r) => !tier || r.criticality === tier);
  // A tier-filtered snapshot must not claim coverage for data it doesn't store.
  // Excluded types are recorded explicitly as not-requested — distinguishable
  // from a completed empty read — and readers skip those mentions so they
  // never shadow an older genuine observation of the same type.
  const coverageDigest = Object.fromEntries(DESCRIPTORS
    .map((d) => [d.type, !tier || d.criticality === tier
      ? result.coverageDigest[d.type]
      : { outcome: 'not-requested', itemCount: null }]));
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const resource of resources) {
    const versionId = await insertResourceVersion(client, {
      snapshotId, resource: { ...resource, fidelity: resource.provenance.fidelity },
    });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  // "complete" means the run finished; coverageDigest carries per-type success.
  // Storage/canonicalization errors still abort without a completed snapshot.
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest });
  // Context is recorded from the full canonicalization (every successfully
  // read type, before the tier storage filter) and the adapter's real
  // outcomes, so collections at any tier update the tenant's identity
  // context while only successful full enumerations may tombstone.
  await recordSymbolContext(client, {
    tenantRef, snapshotId, resources: canonical, coverageDigest: result.coverageDigest,
  });
  return { snapshotId, coverageDigest };
}
