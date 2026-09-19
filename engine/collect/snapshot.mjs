import { collectWithOutcomes } from './entraAdapter.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion, insertReferences } from '../store/db.mjs';

/** Persist outcomes independently of resources, including completed empty reads. */
export async function collectSnapshot(client, { reader, tenantRef, tenantId, tier }) {
  const result = await collectWithOutcomes(reader, { tenantId });
  const resources = canonicalizeAll(result.collected).filter((r) => !tier || r.criticality === tier);
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
  return { snapshotId, coverageDigest };
}
