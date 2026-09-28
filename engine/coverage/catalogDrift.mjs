/**
 * Microsoft API / catalog drift — engine-side diff and persistence (roadmap
 * task-62).
 *
 * tools/qualification/apiDrift.mjs downloads bounded snapshots of the
 * configured official Graph metadata sources; this module owns everything
 * after the bytes arrive: building the compact comparison model, diffing it
 * against the EXPLICIT catalog mappings in tools/tenant-probe/catalog.mjs, and
 * persisting the outcome tenant-scoped.
 *
 * Non-negotiables:
 *
 * 1. REVIEW CANDIDATES ONLY. A finding here is a row an operator reads. This
 *    module never registers a type into tools/tenant-probe/catalog.mjs, never
 *    adds a descriptor, never grants a permission and never calls into
 *    engine/coverage/capabilities.mjs — a changed or added field can
 *    therefore never become writable through this path. The only status a
 *    candidate can hold is 'review' (enforced by the table CHECK).
 * 2. Failure is UNKNOWN, never "no changes". recordSourceState() updates the
 *    pin (digest/ETag/date/version/model) only on a successful fetch; a
 *    timeout, oversized body or network error changes only
 *    last_status/last_error/last_checked_at, so the next run still compares
 *    against the last genuinely observed metadata.
 * 3. A repeat fetch of unchanged metadata must not duplicate findings:
 *    persistCandidates() inserts under the api_drift_candidate_dedupe_idx
 *    identity (tenant, source, kind, path, field) with ON CONFLICT DO NOTHING.
 */

import { assertTenantRef } from '../store/tenantRef.mjs';

export const CANDIDATE_KINDS = Object.freeze(['added-endpoint', 'removed-endpoint', 'changed-field']);

// A changed-field finding carries one of these change descriptors. Pure field
// ADDITIONS to an already-mapped type are deliberately not findings: additive
// metadata cannot break an existing mapping, and candidates are for operator
// review of risk, not for mirroring the whole metadata document.
export const FIELD_CHANGES = Object.freeze(['removed', 'type', 'nullable']);

/**
 * The endpoint name a catalog entry maps to: the last literal (non-parameter)
 * path segment. '/users' -> 'users', '/directory/administrativeUnits' ->
 * 'administrativeUnits', '/organization/{org}/certificateBasedAuthConfiguration'
 * -> 'certificateBasedAuthConfiguration'. Matching by last segment is a
 * heuristic — the emitted rows are review candidates, so a mismatch costs
 * operator attention, never an automatic change.
 */
export function catalogEndpointName(entry) {
  if (!entry || typeof entry.path !== 'string') throw new TypeError('catalog entry requires a path');
  const segments = entry.path.split('/').filter((segment) => segment.length > 0 && !segment.startsWith('{'));
  if (segments.length === 0) throw new Error(`catalog entry ${entry.type} has no literal path segment`);
  return segments[segments.length - 1];
}

function catalogEntriesForVersion(catalog, catalogVersion) {
  return catalog.filter((entry) => entry.version === catalogVersion);
}

/**
 * The compact model persisted per source on api_drift_source.model: the
 * metadata document version, the full endpoint-name list, and the field
 * signatures of CATALOG-MAPPED types only. Persisting only mapped fields keeps
 * the stored model bounded by the catalog size, not by the metadata size —
 * the fetch bound lives in tools/qualification/apiDrift.mjs, this bound lives
 * here.
 *
 * `parsed` is the normalized parse result from apiDrift.mjs:
 * { version, endpoints: Map<name, entityType|null>, types: Map<name, { fields: Map }> }.
 */
export function buildComparisonModel(parsed, catalog, catalogVersion) {
  const entries = catalogEntriesForVersion(catalog, catalogVersion);
  const fields = {};
  for (const entry of entries) {
    const endpoint = catalogEndpointName(entry);
    const entityTypeName = parsed.endpoints.get(endpoint);
    if (entityTypeName === undefined || entityTypeName === null) continue;
    const entityType = parsed.types.get(entityTypeName);
    if (!entityType) continue;
    const signature = {};
    for (const [name, field] of entityType.fields) {
      signature[name] = { type: field.type, nullable: field.nullable };
    }
    fields[entry.type] = signature;
  }
  return {
    version: parsed.version ?? null,
    endpoints: [...parsed.endpoints.keys()].sort(),
    fields,
  };
}

/**
 * Diffs the current model against the explicit catalog mappings and the
 * previously pinned model (null on the first observed fetch). Returns review
 * candidates — plain data, no persistence, no registration side effects.
 */
export function diffCatalog({ previous, current, catalog, catalogVersion }) {
  if (!current || !Array.isArray(current.endpoints)) {
    throw new TypeError('diffCatalog requires a current comparison model');
  }
  const entries = catalogEntriesForVersion(catalog, catalogVersion);
  const currentEndpoints = new Set(current.endpoints);
  const mappedNames = new Set(entries.map(catalogEndpointName));
  const findings = [];

  // An endpoint present in the official metadata but mapped by NO catalog
  // entry: a candidate for an operator to review. resourceType stays null —
  // the candidate names no engine type, because none exists.
  for (const name of current.endpoints) {
    if (mappedNames.has(name)) continue;
    findings.push({
      kind: 'added-endpoint',
      resourceType: null,
      path: `/${name}`,
      field: null,
      detail: {},
    });
  }

  // A catalog mapping whose endpoint has vanished from the metadata.
  for (const entry of entries) {
    if (!currentEndpoints.has(catalogEndpointName(entry))) {
      findings.push({
        kind: 'removed-endpoint',
        resourceType: entry.type,
        path: entry.path,
        field: null,
        detail: {},
      });
    }
  }

  // Changed fields on mapped types. Requires a previously pinned model; the
  // first observed fetch establishes the baseline and reports mappings only.
  if (previous && previous.fields) {
    for (const entry of entries) {
      const before = previous.fields[entry.type];
      const after = current.fields?.[entry.type];
      if (!before || !after) continue;
      for (const [field, prior] of Object.entries(before)) {
        const now = after[field];
        if (!now) {
          findings.push({
            kind: 'changed-field',
            resourceType: entry.type,
            path: entry.path,
            field,
            detail: { change: 'removed', before: prior, after: null },
          });
          continue;
        }
        if (now.type !== prior.type) {
          findings.push({
            kind: 'changed-field',
            resourceType: entry.type,
            path: entry.path,
            field,
            detail: { change: 'type', before: prior.type, after: now.type },
          });
        }
        if (now.nullable !== prior.nullable) {
          findings.push({
            kind: 'changed-field',
            resourceType: entry.type,
            path: entry.path,
            field,
            detail: { change: 'nullable', before: prior.nullable, after: now.nullable },
          });
        }
      }
    }
  }
  return findings;
}

export async function loadSourceState(client, { tenantRef, sourceKey }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT * FROM api_drift_source WHERE tenant_ref = $1 AND source_key = $2`,
    [tenantRef, sourceKey],
  );
  return rows[0] ?? null;
}

/**
 * Records the outcome of one source check. Only a 'fetched' outcome moves the
 * pin (etag, digest, source_date, metadata_version, model); 'not-modified'
 * proves the pin is still current without moving it; every failure status
 * leaves the pin exactly as the last successful fetch established it, so a
 * network failure can never masquerade as "metadata unchanged".
 */
export async function recordSourceState(client, { tenantRef, sourceKey, url, outcome }) {
  assertTenantRef(tenantRef);
  if (!outcome || typeof outcome.status !== 'string') {
    throw new TypeError('recordSourceState requires an outcome with a status');
  }
  const { rows } = await client.query(
    `INSERT INTO api_drift_source
       (tenant_ref, source_key, url, etag, digest, source_date, metadata_version, model,
        last_status, last_error, last_checked_at, last_changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), CASE WHEN $11 THEN now() ELSE NULL END)
     ON CONFLICT (tenant_ref, source_key) DO UPDATE SET
       url = EXCLUDED.url,
       etag = CASE WHEN $9 IN ('fetched','not-modified') THEN COALESCE(EXCLUDED.etag, api_drift_source.etag)
                   ELSE api_drift_source.etag END,
       digest = CASE WHEN $9 = 'fetched' THEN EXCLUDED.digest ELSE api_drift_source.digest END,
       source_date = CASE WHEN $9 = 'fetched' THEN EXCLUDED.source_date ELSE api_drift_source.source_date END,
       metadata_version = CASE WHEN $9 = 'fetched' THEN EXCLUDED.metadata_version ELSE api_drift_source.metadata_version END,
       model = CASE WHEN $9 = 'fetched' THEN EXCLUDED.model ELSE api_drift_source.model END,
       last_status = EXCLUDED.last_status,
       last_error = EXCLUDED.last_error,
       last_checked_at = now(),
       last_changed_at = CASE WHEN $11 THEN now() ELSE api_drift_source.last_changed_at END,
       updated_at = now()
     RETURNING *`,
    [
      tenantRef,
      sourceKey,
      url,
      outcome.etag ?? null,
      outcome.digest ?? null,
      outcome.sourceDate ?? null,
      outcome.metadataVersion ?? null,
      outcome.model ? JSON.stringify(outcome.model) : null,
      outcome.status,
      outcome.error ?? null,
      outcome.status === 'fetched' && outcome.changed === true,
    ],
  );
  return rows[0];
}

/**
 * Persists findings as review candidates. `proof` is the source pin under
 * which the finding was observed (digest, ETag, source date, metadata version,
 * fetch instant, URL) — every candidate carries it so a reviewer can see
 * exactly which document produced the row. Returns how many rows were newly
 * inserted; a repeat run with identical findings inserts zero.
 */
export async function persistCandidates(client, { tenantRef, sourceKey, sourceUrl, findings, proof }) {
  assertTenantRef(tenantRef);
  if (!proof || typeof proof.digest !== 'string' || proof.digest.length === 0) {
    throw new TypeError('persistCandidates requires source proof (at least the pinned digest)');
  }
  let inserted = 0;
  for (const finding of findings) {
    if (!CANDIDATE_KINDS.includes(finding.kind)) {
      throw new TypeError(`unknown candidate kind: ${finding.kind}`);
    }
    const { rowCount } = await client.query(
      `INSERT INTO api_drift_candidate
         (tenant_ref, source_key, source_url, kind, resource_type, path, field, detail, proof)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_ref, source_key, kind, path, (COALESCE(field, ''))) DO NOTHING`,
      [
        tenantRef,
        sourceKey,
        sourceUrl,
        finding.kind,
        finding.resourceType ?? null,
        finding.path,
        finding.field ?? null,
        JSON.stringify(finding.detail ?? {}),
        JSON.stringify(proof),
      ],
    );
    inserted += rowCount;
  }
  return inserted;
}

/** All candidates for a tenant, newest first. An empty table reads as []. */
export async function listCandidates(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT * FROM api_drift_candidate WHERE tenant_ref = $1 ORDER BY detected_at DESC, id`,
    [tenantRef],
  );
  return rows;
}
