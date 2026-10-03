/**
 * Roadmap task-73: the off-site copy writer behind the recoverable point.
 *
 * Kept apart from recoveryMetrics.mjs (the reader the portal imports) because it
 * verifies recovery manifests against artifact bytes on disk, which the portal
 * never does.
 */
import { appendEvidence } from '../govern/evidence.mjs';
import { verifyRecoveryManifest } from '../storage/recoveryManifest.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { classifyOffsiteRecord, OFFSITE_COPY_EVIDENCE_KIND, RECOVERY_METRICS_VERSION } from './recoveryMetrics.mjs';

function instant(value) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}


/**
 * Records one off-site copy. The recovery manifest is verified HERE against the
 * actual artifact bytes (task-67 verifyRecoveryManifest), never taken from the
 * caller. A copy that fails verification is recorded too, as not verified, so a
 * failed shipment is visible rather than silently missing.
 */
export async function recordOffsiteCopy(client, {
  tenantRef, manifest, remoteSha256, shippedAt, actor, verifyOptions = {}, verify = verifyRecoveryManifest, eventSink,
}) {
  assertTenantRef(tenantRef);
  const shipped = instant(shippedAt);
  if (!shipped) throw new TypeError('shippedAt must be the instant the off-site copy was confirmed');
  if (typeof actor !== 'string' || actor.length === 0) throw new TypeError('actor is required');
  const verification = await verify(manifest, { ...verifyOptions, expectedTenantRef: tenantRef });
  const subject = {
    version: RECOVERY_METRICS_VERSION,
    tenantRef,
    manifestTenantRef: manifest?.tenantRef ?? null,
    manifestGeneratedAt: manifest?.generatedAt ?? null,
    dumpSha256: manifest?.dump?.sha256 ?? null,
    remoteSha256: typeof remoteSha256 === 'string' ? remoteSha256.toLowerCase() : null,
    shippedAt: shipped.toISOString(),
    observationIds: Array.isArray(manifest?.observationIds) ? [...manifest.observationIds] : [],
    verification: {
      ok: verification.ok === true,
      recoveryComplete: verification.recoveryComplete === true,
      failures: verification.failures ?? [],
      incomplete: verification.incomplete ?? [],
    },
  };
  const record = await appendEvidence(client, { tenantRef, kind: OFFSITE_COPY_EVIDENCE_KIND, subject, actor, ...(eventSink ? { eventSink } : {}) });
  return { record, subject, verdict: classifyOffsiteRecord(subject, { tenantRef }) };
}
