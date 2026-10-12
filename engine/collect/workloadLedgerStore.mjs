/**
 * Gap W1 and W3: the workload ledger's inputs, persisted.
 *
 * buildWorkloadLedger() (workloadContract.mjs) needs the live evidence rows, the
 * collector app's observed grants and the module versions in use. Until now those
 * existed only in memory inside tools/qualification/workloads.mjs, so nothing on a
 * schedule could rebuild the ledger. This module stores them and rebuilds the ledger
 * from them. The ledger itself is never stored: rebuilding it on every run keeps the
 * 30-day, version and tenant rules applying at the moment of each run.
 *
 * Only live captures and live write captures are stored. A fixture result never
 * counts as live proof, so there is nothing to persist for it.
 */
import { LIVE_EVIDENCE_MAX_AGE_MS, buildWorkloadLedger } from './workloadContract.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PROOF_EXPIRY_WARNING_DAYS = 14;
const KINDS = new Set(['live-capture', 'live-write-capture']);

function sortedStrings(list) {
  return [...new Set((list ?? []).map(String))].sort();
}

/**
 * Stores evidence rows and grants for one tenant in one transaction. Re-importing the
 * same proof replaces its rows (same tenant, operation and proof reference), so an
 * import is safe to repeat. Grants and module versions replace the previous ones.
 *   evidence: [{ operationId, kind, synthetic, tenantRef, capturedAt, version, ok, readBackVerified?, error?, observed?, proofRef }]
 *   grants / restorerGrants: { permissions, roles } or null to leave unchanged
 *   runtime: { modules: { [module]: version } }
 */
export async function saveLedgerInputs(client, { tenantRef, evidence = [], grants = null, restorerGrants = null, runtime = null }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  for (const item of evidence) {
    if (!KINDS.has(item.kind)) throw new Error(`${item.operationId}: only live captures are stored, not ${item.kind ?? 'unlabelled'} evidence`);
    if (item.tenantRef !== tenantRef) throw new Error(`${item.operationId}: evidence from another tenant is never stored here`);
    if (typeof item.proofRef !== 'string' || !item.proofRef) throw new Error(`${item.operationId}: proofRef is required`);
  }
  await client.query('BEGIN');
  try {
    for (const item of evidence) {
      await client.query(
        `INSERT INTO workload_ledger_evidence
           (tenant_ref, operation_id, proof_ref, kind, synthetic, captured_at, version, ok, read_back_verified, error, observed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_ref, operation_id, proof_ref) DO UPDATE SET
           kind = EXCLUDED.kind, synthetic = EXCLUDED.synthetic, captured_at = EXCLUDED.captured_at,
           version = EXCLUDED.version, ok = EXCLUDED.ok, read_back_verified = EXCLUDED.read_back_verified,
           error = EXCLUDED.error, observed = EXCLUDED.observed, imported_at = now()`,
        [tenantRef, item.operationId, item.proofRef, item.kind, item.synthetic !== false, item.capturedAt ?? null,
          item.version ?? null, item.ok === true, item.kind === 'live-write-capture' ? item.readBackVerified === true : null,
          item.error ?? null, item.observed ?? null],
      );
    }
    const modules = runtime?.modules ?? {};
    for (const [app, held] of [['collector', grants], ['restorer', restorerGrants]]) {
      if (!held) continue;
      await client.query(
        `INSERT INTO workload_ledger_grants (tenant_ref, app, permissions, roles, modules)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_ref, app) DO UPDATE SET
           permissions = EXCLUDED.permissions, roles = EXCLUDED.roles, modules = EXCLUDED.modules, imported_at = now()`,
        [tenantRef, app, JSON.stringify(sortedStrings(held.permissions)), JSON.stringify(sortedStrings(held.roles)), modules],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

/** The stored inputs, in the shapes buildWorkloadLedger and workloadWriteQualification take. */
export async function loadLedgerInputs(client, { tenantRef }) {
  const { rows: evidenceRows } = await client.query(
    `SELECT * FROM workload_ledger_evidence WHERE tenant_ref = $1 ORDER BY captured_at DESC NULLS LAST, operation_id, proof_ref`,
    [tenantRef],
  );
  const { rows: grantRows } = await client.query('SELECT * FROM workload_ledger_grants WHERE tenant_ref = $1', [tenantRef]);
  const byApp = new Map(grantRows.map((row) => [row.app, row]));
  const asGrants = (row) => (row ? { permissions: [...row.permissions], roles: [...row.roles] } : null);
  const toItem = (row) => ({
    operationId: row.operation_id,
    kind: row.kind,
    synthetic: row.synthetic,
    tenantRef: row.tenant_ref,
    capturedAt: iso(row.captured_at),
    version: row.version,
    ok: row.ok,
    ...(row.kind === 'live-write-capture' ? { readBackVerified: row.read_back_verified === true } : {}),
    error: row.error,
    observed: row.observed,
    proofRef: row.proof_ref,
  });
  return {
    reads: evidenceRows.filter((row) => row.kind === 'live-capture').map(toItem),
    writes: evidenceRows.filter((row) => row.kind === 'live-write-capture').map(toItem),
    grants: asGrants(byApp.get('collector')),
    restorerGrants: asGrants(byApp.get('restorer')),
    runtime: { modules: { ...(byApp.get('collector')?.modules ?? {}) } },
  };
}

/** The task-101 ledger for this tenant, rebuilt from the stored inputs at `now`. */
export async function loadWorkloadLedger(client, { tenantRef, now = new Date() }) {
  const inputs = await loadLedgerInputs(client, { tenantRef });
  const ledger = buildWorkloadLedger({ evidence: inputs.reads, grants: inputs.grants, runtime: inputs.runtime, tenantRef, now });
  return { ledger, inputs };
}

/**
 * Gap W3: when each stored live proof stops counting. Live read and write proof both
 * lapse 30 days after capture (LIVE_EVIDENCE_MAX_AGE_MS, WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS),
 * and nothing recaptures it on its own. One entry per proof, dated by its OLDEST capture,
 * since that is the first operation to lapse. `status` is `expired`, `expiring` (within
 * PROOF_EXPIRY_WARNING_DAYS) or `current`.
 */
export function proofExpiry(items, { now = new Date(), warningDays = PROOF_EXPIRY_WARNING_DAYS } = {}) {
  const groups = new Map();
  for (const item of items) {
    const at = Date.parse(item.capturedAt ?? '');
    if (Number.isNaN(at) || item.synthetic !== false) continue;
    const group = groups.get(item.proofRef) ?? { proofRef: item.proofRef, oldest: at, operations: new Set() };
    group.oldest = Math.min(group.oldest, at);
    group.operations.add(item.operationId);
    groups.set(item.proofRef, group);
  }
  return [...groups.values()].map((group) => {
    const expiresAt = group.oldest + LIVE_EVIDENCE_MAX_AGE_MS;
    const daysLeft = Math.floor((expiresAt - now.getTime()) / DAY_MS);
    const status = expiresAt <= now.getTime() ? 'expired' : daysLeft < warningDays ? 'expiring' : 'current';
    const gate = String(group.proofRef).split('@')[0];
    return {
      gate,
      proofRef: group.proofRef,
      capturedAt: new Date(group.oldest).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      daysLeft,
      status,
      operations: [...group.operations].sort(),
      message: status === 'expired'
        ? `The ${gate} live proof expired on ${new Date(expiresAt).toISOString().slice(0, 10)}. Recapture it.`
        : `The ${gate} live proof expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${new Date(expiresAt).toISOString().slice(0, 10)}).${status === 'expiring' ? ' Recapture it before then.' : ''}`,
    };
  }).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.gate.localeCompare(b.gate));
}

/** Proof expiry for the coverage report. A database without the tables reads as no proof. */
export async function loadProofExpiry(client, { tenantRef, now = new Date() }) {
  const { rows: [table] } = await client.query("SELECT to_regclass('workload_ledger_evidence') IS NOT NULL AS present");
  if (!table?.present) return [];
  const { reads, writes } = await loadLedgerInputs(client, { tenantRef });
  return proofExpiry([...reads, ...writes], { now });
}
