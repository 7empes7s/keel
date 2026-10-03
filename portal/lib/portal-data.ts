import { buildCoverageReport } from "../../engine/coverage/report.mjs";
import { loadRecoveryMetrics } from "../../engine/coverage/recoveryMetrics.mjs";
import { protectionHeadline } from "../../engine/coverage/protectionHeadline.mjs";
import { DESCRIPTORS } from "../../engine/collect/descriptors.mjs";
import { readFileSync } from "node:fs";

import { listBaselines } from "../../engine/govern/baseline.mjs";
import {
  baselineCompliance,
  complianceFindings,
  storageResidency,
} from "../../engine/govern/baselineCompliance.mjs";
import { listIncidentRecoveryPoints, listIncidents } from "../../engine/govern/incidents.mjs";
import {
  getActiveBaseline,
  listOpenDrift,
} from "../../engine/store/governance.mjs";
import { connect } from "../../engine/store/db.mjs";
import { OPEN_DRIFT_PREDICATE } from "../../engine/store/openDrift.mjs";
import { captureApprovalScope, scopePredicate } from "../../engine/authz/entityScope.mjs";
import { routeApproval } from "../../engine/govern/approvals.mjs";
import { MAX_ATTRIBUTED_CHANGES, attributeChanges, changedFields } from "../../engine/identity/attribution.mjs";
import { loadBreakGlassReadiness } from "../../engine/safety/breakGlassReadiness.mjs";
import {
  getEvidenceIntegrity,
  getLastCollection,
} from "../../status/queries.mjs";
import { CATALOG } from "../../tools/tenant-probe/catalog.mjs";

import type { EntityScope } from "@/lib/principal";
import { BLAST_RADIUS_ORDER, formatTimestamp } from "@/lib/presentation";
import type { ReadinessData } from "@/lib/readiness-view";
import type { IncidentPointSummary, RecoveryMetrics, ResilienceData } from "@/lib/resilience-view";
import { databaseUrl, recoveryManifestPath, tenantRef } from "@/lib/runtime-config";
import type {
  BaselineCapture,
  BaselineChanges,
  BaselineRecord,
  BaselinesData,
  ComplianceData,
  ComplianceFinding,
  ComplianceSummary,
  StorageResidency,
  CapabilityClaim,
  CoverageData,
  CoverageDiagnosis,
  CoverageObservation,
  CoverageType,
  DashboardAlert,
  DashboardData,
  DeclaredEndpoint,
  DiagnosisState,
  ChangeAttribution,
  DriftData,
  DriftRecord,
  ExpansionStatus,
  Fidelity,
  ProtectionState,
  ProtectionHeadline,
  QualificationDecision,
  Ref,
  RestoreScope,
  TypeExpansion,
  UnrecoverableItem,
  TypeQualification,
  WriteCapabilitySummary,
  WriteOperationCapability,
} from "@/lib/types";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

async function withClient<T>(operation: (client: KeelClient) => Promise<T>): Promise<T> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function fidelity(value: unknown): Fidelity | null {
  return value === "full" ||
    value === "partial" ||
    value === "read-only" ||
    value === "unprotectable"
    ? value
    : null;
}

function coverageOutcome(value: unknown): CoverageType["outcome"] {
  return value === "complete" ||
    value === "complete-empty" ||
    value === "partial" ||
    value === "failed" ||
    value === "not-requested"
    ? value
    : null;
}

function protectionState(
  reportStatus: string,
  declared: Fidelity | null,
  measured: Fidelity | null,
): ProtectionState {
  if (reportStatus === "failed") return "failed";
  if (reportStatus === "not-covered" || reportStatus === "never-collected") {
    return "not-covered";
  }

  switch (measured ?? declared) {
    case "full":
      return "protected";
    case "partial":
      return "partially-protected";
    case "read-only":
      return "read-only";
    case "unprotectable":
      return "unprotectable";
    default:
      return "not-covered";
  }
}

const CAPABILITY_CLAIMS: readonly CapabilityClaim[] = [
  "declared", "fixture-tested", "live-qualified", "unsupported", "unknown",
];
const DIAGNOSIS_STATES: readonly DiagnosisState[] = [
  "missing-license", "disabled-plan", "missing-scope", "missing-role", "unknown",
];
const PROJECTION_STATES = ["reviewed-empty", "unreviewed", "has-rules"] as const;

function capabilityClaim(value: unknown): CapabilityClaim {
  return CAPABILITY_CLAIMS.includes(value as CapabilityClaim) ? (value as CapabilityClaim) : "unknown";
}

function normalizeOperationCapability(raw: UnknownRecord): WriteOperationCapability {
  return {
    claim: capabilityClaim(raw.claim),
    credentialMode: raw.credentialMode === "collector" || raw.credentialMode === "restorer"
      ? raw.credentialMode
      : null,
    idOutcome: typeof raw.idOutcome === "string" ? raw.idOutcome : null,
    handler: typeof raw.handler === "string" ? raw.handler : null,
    proofRef: typeof raw.proofRef === "string" ? raw.proofRef : null,
    projection: PROJECTION_STATES.includes(raw.projection as typeof PROJECTION_STATES[number])
      ? (raw.projection as WriteOperationCapability["projection"])
      : "unreviewed",
  };
}

function normalizeWriteCapability(raw: unknown): WriteCapabilitySummary | null {
  const record = raw as UnknownRecord | null;
  const operations = record?.operations as UnknownRecord | undefined;
  if (!record || !operations) return null;
  return {
    resourceType: String(record.resourceType),
    operations: {
      create: normalizeOperationCapability((operations.create ?? {}) as UnknownRecord),
      update: normalizeOperationCapability((operations.update ?? {}) as UnknownRecord),
      delete: normalizeOperationCapability((operations.delete ?? {}) as UnknownRecord),
      "restore-soft-deleted": normalizeOperationCapability(
        (operations["restore-soft-deleted"] ?? {}) as UnknownRecord,
      ),
    },
  };
}

const QUALIFICATION_DECISIONS: QualificationDecision[] = ["automated", "manual", "unknown"];

function normalizeQualification(raw: unknown): TypeQualification | null {
  const record = raw as UnknownRecord | null;
  if (!record || !QUALIFICATION_DECISIONS.includes(record.decision as QualificationDecision)) return null;
  const remapping: Record<string, boolean> = {};
  if (record.remapping && typeof record.remapping === "object") {
    for (const [operation, qualified] of Object.entries(record.remapping as UnknownRecord)) {
      if (typeof qualified === "boolean") remapping[operation] = qualified;
    }
  }
  return {
    decision: record.decision as QualificationDecision,
    reason: typeof record.reason === "string" ? record.reason : null,
    softRestoreCandidate: record.softRestoreCandidate === true,
    remapping,
    expansion: normalizeExpansion(record.expansion),
  };
}

const EXPANSION_STATUSES: ExpansionStatus[] = ["qualified-subset", "manual", "unsupported", "research-needed"];
const RESTORE_SCOPES: RestoreScope[] = ["none", "partial", "full"];

// Roadmap task-107. An unrecognised status or scope reads as no batch record,
// never as a stronger claim.
function normalizeExpansion(raw: unknown): TypeExpansion | null {
  const record = raw as UnknownRecord | null;
  if (!record || typeof record !== "object") return null;
  if (!EXPANSION_STATUSES.includes(record.status as ExpansionStatus)) return null;
  if (!RESTORE_SCOPES.includes(record.restoreScope as RestoreScope)) return null;
  if (typeof record.batch !== "string" || typeof record.reason !== "string") return null;
  return {
    batch: record.batch,
    batchLabel: typeof record.batchLabel === "string" ? record.batchLabel : record.batch,
    status: record.status as ExpansionStatus,
    restoreScope: record.restoreScope as RestoreScope,
    reason: record.reason,
    qualifiedSubtypes: Array.isArray(record.qualifiedSubtypes)
      ? record.qualifiedSubtypes.filter((value): value is string => typeof value === "string")
      : [],
    unrecoverable: normalizeUnrecoverable(record.unrecoverable),
  };
}

// Roadmap task-109. A malformed or missing list reads as "not assessed" (null),
// never as "nothing is lost".
function normalizeUnrecoverable(raw: unknown): UnrecoverableItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: UnrecoverableItem[] = [];
  for (const entry of raw) {
    const item = entry as UnknownRecord | null;
    if (!item || typeof item !== "object") return null;
    if (item.kind !== "configuration" && item.kind !== "relationship") return null;
    if (typeof item.name !== "string" || typeof item.reason !== "string") return null;
    items.push({ kind: item.kind, name: item.name, reason: item.reason });
  }
  return items;
}

function normalizeDiagnosis(raw: unknown): CoverageDiagnosis | null {
  const record = raw as UnknownRecord | null;
  if (!record) return null;
  const rawOriginal = (record.original ?? null) as UnknownRecord | null;
  return {
    diagnosis: DIAGNOSIS_STATES.includes(record.diagnosis as DiagnosisState)
      ? (record.diagnosis as DiagnosisState)
      : "unknown",
    reason: typeof record.reason === "string" ? record.reason : undefined,
    original: {
      httpStatus: typeof rawOriginal?.httpStatus === "number" ? rawOriginal.httpStatus : null,
      graphCode: typeof rawOriginal?.graphCode === "string" ? rawOriginal.graphCode : null,
    },
    confirmed: record.confirmed && typeof record.confirmed === "object"
      ? (record.confirmed as Record<string, unknown>)
      : undefined,
  };
}

function normalizeDeclaredEndpoint(raw: unknown): DeclaredEndpoint | null {
  const record = raw as UnknownRecord | null;
  if (!record || typeof record.path !== "string" || typeof record.apiVersion !== "string") return null;
  return { path: record.path, apiVersion: record.apiVersion };
}

function normalizeObservation(raw: unknown): CoverageObservation | null {
  const record = raw as UnknownRecord | null;
  if (!record || typeof record.observationId !== "string") return null;
  const rawWindow = (record.window ?? null) as UnknownRecord | null;
  return {
    observationId: record.observationId,
    window: rawWindow && typeof rawWindow.startedAt === "string" && typeof rawWindow.endedAt === "string"
      ? { startedAt: rawWindow.startedAt, endedAt: rawWindow.endedAt }
      : null,
    completeness: typeof record.completeness === "string" ? record.completeness : "unknown",
    evidenceLevel: typeof record.evidenceLevel === "string" ? record.evidenceLevel : "unknown",
  };
}

function normalizeCoverageType(raw: UnknownRecord): CoverageType {
  const rawFidelity = (raw.fidelity ?? null) as UnknownRecord | null;
  const verifiedBy = (rawFidelity?.verifiedBy ?? null) as UnknownRecord | null;
  const declared = fidelity(rawFidelity?.declared);
  const measured = fidelity(verifiedBy?.measuredFidelity);
  const reportStatus = String(raw.status) as CoverageType["reportStatus"];
  const rawDetail = (raw.detail ?? null) as UnknownRecord | null;

  return {
    type: String(raw.type),
    reportStatus,
    protectionState: protectionState(reportStatus, declared, measured),
    stale: raw.stale === true,
    itemCount: typeof raw.itemCount === "number" ? raw.itemCount : null,
    lastCollectedAt: iso(raw.lastCollectedAt),
    adapter: typeof raw.adapter === "string" ? raw.adapter : null,
    outcome: coverageOutcome(raw.outcome),
    detail: rawDetail
      ? {
          httpStatus: typeof rawDetail.httpStatus === "number" ? rawDetail.httpStatus : null,
          graphCode: typeof rawDetail.graphCode === "string" ? rawDetail.graphCode : null,
          message: typeof rawDetail.message === "string" ? rawDetail.message : null,
          endpoint: typeof rawDetail.endpoint === "string" ? rawDetail.endpoint : null,
          apiVersion: typeof rawDetail.apiVersion === "string" ? rawDetail.apiVersion : null,
          pagesCompleted:
            typeof rawDetail.pagesCompleted === "number" ? rawDetail.pagesCompleted : null,
          startedAt: iso(rawDetail.startedAt),
          completedAt: iso(rawDetail.completedAt),
        }
      : null,
    fidelity: {
      declared,
      measured,
      verifiedAt: iso(verifiedBy?.at),
    },
    criticality: typeof raw.criticality === "string" ? raw.criticality : null,
    blastRadius: typeof raw.blastRadius === "string" ? raw.blastRadius : null,
    remappable: typeof raw.remappable === "boolean" ? raw.remappable : null,
    declaredEndpoint: normalizeDeclaredEndpoint(raw.declaredEndpoint),
    irrecoverableFields: Array.isArray(raw.irrecoverableFields)
      ? raw.irrecoverableFields.filter((field): field is string => typeof field === "string")
      : null,
    relationshipCompleteness: "unknown",
    diagnosis: normalizeDiagnosis(raw.diagnosis),
    writeCapability: normalizeWriteCapability(raw.writeCapability),
    qualification: normalizeQualification(raw.qualification),
    observation: normalizeObservation(raw.observation),
  };
}

function normalizeBaseline(raw: UnknownRecord): BaselineRecord {
  return {
    id: String(raw.id),
    label: typeof raw.label === "string" ? raw.label : null,
    description: typeof raw.description === "string" ? raw.description : null,
    setAt: iso(raw.set_at) ?? "",
    setBy: String(raw.set_by),
    active: Boolean(raw.active),
    resourceCount: Number(raw.resource_count ?? 0),
  };
}

function normalizeDrift(raw: UnknownRecord): DriftRecord {
  return {
    id: String(raw.id),
    naturalKey: String(raw.natural_key),
    resourceType: String(raw.resource_type),
    changeType: String(raw.change_type) as DriftRecord["changeType"],
    blastRadius: String(raw.blast_radius),
    detectedAt: iso(raw.detected_at) ?? "",
    before: raw.before_payload ?? null,
    after: raw.after_payload ?? null,
  };
}

async function rawCoverageReport(client: KeelClient, ref: string): Promise<UnknownRecord> {
  return (await buildCoverageReport(client, {
    tenantRef: ref,
    catalog: CATALOG,
    descriptors: DESCRIPTORS,
    now: new Date(),
  })) as UnknownRecord;
}

async function coverageFor(client: KeelClient, ref: string, report?: UnknownRecord): Promise<CoverageData> {
  const raw = report ?? await rawCoverageReport(client, ref);
  const rawSummary = raw.summary as UnknownRecord;
  const types = (raw.types as UnknownRecord[]).map(normalizeCoverageType);

  return {
    generatedAt: iso(raw.generatedAt) ?? new Date().toISOString(),
    snapshot: raw.snapshot
      ? {
          id: String((raw.snapshot as UnknownRecord).id),
          status: String((raw.snapshot as UnknownRecord).status),
          startedAt: iso((raw.snapshot as UnknownRecord).startedAt),
          completedAt: iso((raw.snapshot as UnknownRecord).completedAt),
        }
      : null,
    summary: {
      covered: Number(rawSummary.covered ?? 0),
      failed: Number(rawSummary.failed ?? 0),
      notCovered: Number(rawSummary.notCovered ?? 0),
      neverCollected: Number(rawSummary.neverCollected ?? 0),
      stale: Number(rawSummary.stale ?? 0),
      total: types.length,
    },
    types,
  };
}

async function baselinesFor(client: KeelClient, ref: string): Promise<BaselineRecord[]> {
  const rows = (await listBaselines(client, { tenantRef: ref })) as UnknownRecord[];
  return rows.map(normalizeBaseline);
}

// Roadmap task-87: every baseline with its capture, version chain and changes since
// capture, computed by the engine reader at `now` from stored capture times.
async function baselinesWithCapture(client: KeelClient, ref: string, now: Date): Promise<BaselineRecord[]> {
  const [baselines, compliance] = await Promise.all([
    baselinesFor(client, ref),
    baselineCompliance(client, { tenantRef: ref, now }) as Promise<UnknownRecord[]>,
  ]);
  const byId = new Map(compliance.map((entry) => [String(entry.id), entry]));
  return baselines.map((baseline) => {
    const entry = byId.get(baseline.id);
    if (!entry) return baseline;
    return {
      ...baseline,
      version: Number(entry.version ?? 1),
      supersedesId: (entry.supersedesId as string | null) ?? null,
      supersededById: (entry.supersededById as string | null) ?? null,
      supersededAt: (entry.supersededAt as string | null) ?? null,
      capture: entry.capture as BaselineCapture,
      changesSinceCapture: entry.changesSinceCapture as BaselineChanges,
    };
  });
}

function readRecoveryManifest(): { manifest: UnknownRecord | null; source: string | null } {
  const path = recoveryManifestPath();
  if (!path) return { manifest: null, source: null };
  try {
    return { manifest: JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as UnknownRecord, source: path };
  } catch {
    // An unreadable manifest is reported as not configured, never guessed.
    return { manifest: null, source: path };
  }
}

export async function getComplianceData(): Promise<ComplianceData> {
  const ref = tenantRef();
  const now = new Date();
  const { manifest, source } = readRecoveryManifest();
  const storage = { ...(storageResidency({ manifest }) as Omit<StorageResidency, "source">), source };
  return withClient(async (client) => {
    const [{ findings, summary }, baselines] = await Promise.all([
      complianceFindings(client, { tenantRef: ref, now }) as Promise<{ findings: ComplianceFinding[]; summary: ComplianceSummary }>,
      baselinesWithCapture(client, ref, now),
    ]);
    return {
      generatedAt: now.toISOString(),
      findings,
      summary,
      storage,
      activeBaseline: baselines.find((baseline) => baseline.active) ?? null,
    };
  });
}

async function activeDriftFor(
  client: KeelClient,
  ref: string,
  activeBaselineId: string | null,
): Promise<DriftRecord[]> {
  if (!activeBaselineId) return [];
  const rows = (await listOpenDrift(client, { tenantRef: ref })) as UnknownRecord[];
  return rows
    .filter((row) => String(row.baseline_id) === activeBaselineId)
    .map(normalizeDrift);
}

export const DRIFT_TREND_DAYS = 30;

// Zero-fills the window so every day is one point: a gap in detection is a real zero,
// not a missing sample, and the x-axis stays linear in time.
export function fillDriftTrend(
  rows: Array<{ day: string; count: number }>,
  end: Date,
  days = DRIFT_TREND_DAYS,
): Array<{ day: string; count: number }> {
  const counts = new Map(rows.map((row) => [row.day, row.count]));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(last - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
}

async function driftTrendFor(
  client: KeelClient,
  ref: string,
  activeBaselineId: string | null,
  end: Date,
): Promise<Array<{ day: string; count: number }>> {
  if (!activeBaselineId) return fillDriftTrend([], end);
  const { rows } = await client.query(
    `SELECT to_char(date_trunc('day', detected_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            count(*)::int AS count
       FROM drift
      WHERE tenant_ref = $1
        AND baseline_id = $2
        AND detected_at >= $3
      GROUP BY 1`,
    [ref, activeBaselineId, new Date(end.getTime() - DRIFT_TREND_DAYS * 86_400_000)],
  );
  return fillDriftTrend(
    rows.map((row) => ({ day: String(row.day), count: Number(row.count) })),
    end,
  );
}

export async function getCoverageData(): Promise<CoverageData> {
  const ref = tenantRef();
  return withClient((client) => coverageFor(client, ref));
}

export async function getBaselinesData(): Promise<BaselinesData> {
  const ref = tenantRef();
  const now = new Date();
  return withClient(async (client) => {
    const baselines = await baselinesWithCapture(client, ref, now);
    const people = await principalRefs(client, baselines.map((baseline) => baseline.setBy).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)));
    return {
      generatedAt: now.toISOString(),
      baselines: baselines.map((baseline) => {
        // A principal id resolves to a name; a system actor ("scheduler") is named by itself.
        const setByRef: Ref = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(baseline.setBy)
          ? people.get(baseline.setBy)!
          : { kind: "person", id: baseline.setBy, name: baseline.setBy, href: null };
        return { ...baseline, setByRef };
      }),
    };
  });
}

const CENTRAL_SCOPE: EntityScope = { central: true, entities: [] };

// Task 90: the drift reader for an entity-scoped principal. The entity filter is part
// of the SQL that selects the rows and counts the baseline, so neither the list nor
// the baseline's resource count includes a resource outside the reader's entities.
// Attribution goes through the row's lineage at its own time and that lineage's
// current, unexpired ownership evidence (engine/authz/entityScope.mjs).
async function scopedOpenDrift(client: KeelClient, ref: string, baselineId: string, scope: EntityScope): Promise<DriftRecord[]> {
  const visible = scopePredicate(scope, {
    tenantRef: ref, typeExpr: "d.resource_type", keyExpr: "d.natural_key", asOfExpr: "d.detected_at", nextParam: 3,
  }) as { sql: string; values: unknown[] };
  const { rows } = await client.query(
    `SELECT d.* FROM drift d
      WHERE d.tenant_ref = $1 AND d.baseline_id = $2 AND ${OPEN_DRIFT_PREDICATE} AND ${visible.sql}
      ORDER BY d.detected_at, d.id`,
    [ref, baselineId, ...visible.values],
  );
  return rows.map(normalizeDrift);
}

async function scopedBaselineCount(client: KeelClient, ref: string, baselineId: string, scope: EntityScope): Promise<number> {
  const visible = scopePredicate(scope, {
    tenantRef: ref, typeExpr: "rv.resource_type", keyExpr: "br.natural_key",
    asOfExpr: "COALESCE(s.completed_at, s.started_at)", nextParam: 2,
  }) as { sql: string; values: unknown[] };
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM baseline_resource br
       JOIN resource_version rv ON rv.id = br.resource_version_id
       JOIN snapshot s ON s.id = rv.snapshot_id
      WHERE br.baseline_id = $1 AND ${visible.sql}`,
    [baselineId, ...visible.values],
  );
  return Number(rows[0]?.count ?? 0);
}

// Task 91: who made each open change, from audit evidence (engine/identity/attribution.mjs),
// and where a roll back of it would be routed (approvals.mjs#routeApproval), computed
// server-side for the changes this reader may already see. The change window runs from
// when KEEL captured the baseline's version of the resource (the baseline's own time
// for an added resource) to the collection that saw the change. A reader that cannot
// be attributed (no audit tables, a failed query) gets null, never a guess.
async function withAttribution(client: KeelClient, ref: string, baselineId: string, items: DriftRecord[], scope: EntityScope): Promise<DriftRecord[]> {
  const bounded = items.slice(0, MAX_ATTRIBUTED_CHANGES);
  if (!bounded.length) return items;
  try {
    const { rows } = await client.query(
      `SELECT d.id,
              COALESCE(bs.completed_at, bs.started_at, b.set_at) AS window_from,
              COALESCE(os.completed_at, d.detected_at) AS window_until
         FROM drift d
         JOIN baseline b ON b.id = d.baseline_id
         JOIN snapshot os ON os.id = d.observed_snapshot
         LEFT JOIN baseline_resource br ON br.baseline_id = d.baseline_id AND br.natural_key = d.natural_key
         LEFT JOIN resource_version rv ON rv.id = br.resource_version_id
         LEFT JOIN snapshot bs ON bs.id = rv.snapshot_id
        WHERE d.tenant_ref = $1 AND d.baseline_id = $2 AND d.id = ANY($3::uuid[])`,
      [ref, baselineId, bounded.map((item) => item.id)],
    );
    const windows = new Map(rows.map((row) => [String(row.id), { from: iso(row.window_from), until: iso(row.window_until) }]));
    const changes = bounded.filter((item) => windows.get(item.id)?.until).map((item) => ({
      id: item.id, resourceType: item.resourceType, naturalKey: item.naturalKey, changeType: item.changeType,
      fields: changedFields(item.before, item.after), window: windows.get(item.id)!,
    }));
    const attributed = (await attributeChanges(client, { tenantRef: ref, changes, scope })) as Array<Omit<ChangeAttribution, "route"> & { changeId: string }>;
    const byId = new Map(attributed.map((entry) => [entry.changeId, entry]));
    const approverCache = new Map();
    const result: DriftRecord[] = [];
    for (const item of items) {
      const found = byId.get(item.id);
      if (!found) { result.push({ ...item, attribution: null }); continue; }
      const { changeId: _changeId, ...attribution } = found;
      const entityScope = await captureApprovalScope(client, { tenantRef: ref, resources: [{ resourceType: item.resourceType, naturalKey: item.naturalKey }] });
      const route = (await routeApproval(client, { tenantRef: ref, entityScope, approverCache })) as {
        route: "entity" | "central" | "refused"; reason?: string; entityCode?: string; approvers?: string[]; routedAt: string;
      };
      result.push({
        ...item,
        attribution: {
          ...attribution,
          route: { route: route.route, reason: route.reason, entityCode: route.entityCode, approverCount: route.approvers?.length ?? 0, routedAt: route.routedAt },
        },
      });
    }
    return result;
  } catch (error) {
    console.error("[keel-portal] change attribution unavailable", error);
    return items.map((item) => ({ ...item, attribution: null }));
  }
}

export async function getDriftData(scope: EntityScope = CENTRAL_SCOPE): Promise<DriftData> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const active = (await getActiveBaseline(client, { tenantRef: ref })) as
      | UnknownRecord
      | null;
    const baselines = await baselinesFor(client, ref);
    const found = active
      ? baselines.find((candidate) => candidate.id === String(active.id)) ??
        normalizeBaseline({ ...active, resource_count: 0 })
      : null;
    if (scope.central || !found) {
      const items = await activeDriftFor(client, ref, found?.id ?? null);
      return { generatedAt: new Date().toISOString(), baseline: found, items: found ? await withAttribution(client, ref, found.id, items, scope) : items };
    }
    const baseline = { ...found, resourceCount: await scopedBaselineCount(client, ref, found.id, scope) };
    const items = await withAttribution(client, ref, found.id, await scopedOpenDrift(client, ref, found.id, scope), scope);
    return { generatedAt: new Date().toISOString(), baseline, items, scope: { central: false, entities: scope.entities } };
  });
}

// Plan task 17 (portal-design §4.1): the restore surface lists the resources an
// operator can select from one snapshot. The filter mirrors cli/keel-restore.mjs —
// users are never written; authentication strengths are listed since roadmap
// task-108 (the engine writes custom ones and skips built-in ones as immutable) —
// and the query is scoped to this tenant's snapshot so another tenant's snapshot id is
// indistinguishable from one that does not exist.
export interface RestoreResource {
  naturalKey: string;
  resourceType: string;
  blastRadius: string;
}

export interface RestoreResourcesData {
  generatedAt: string;
  snapshotId: string;
  resources: RestoreResource[];
}

export async function getRestoreResources(
  snapshotId: string,
): Promise<RestoreResourcesData> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const queryClient = client as KeelClient & {
      query(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: UnknownRecord[] }>;
    };
    const { rows } = await queryClient.query(
      `SELECT rv.natural_key, rv.resource_type, rv.blast_radius
       FROM resource_version rv
       JOIN snapshot s ON s.id = rv.snapshot_id
       WHERE rv.snapshot_id = $1 AND s.tenant_ref = $2
         AND rv.resource_type <> 'user'
       ORDER BY rv.natural_key`,
      [snapshotId, ref],
    );
    return {
      generatedAt: new Date().toISOString(),
      snapshotId,
      resources: rows.map((row) => ({
        naturalKey: String(row.natural_key),
        resourceType: String(row.resource_type),
        blastRadius: String(row.blast_radius),
      })),
    };
  });
}

// Roadmap task-71: incident-qualified recovery points. Every value comes from the
// engine's tenant-scoped readers; the recommended point is the engine's (the newest
// cleared snapshot), never recomputed here. Per the portal experience contract every
// reference is resolved to a name server-side: one query for people, one for the
// excluded resources' display names, snapshots named by when they were taken.
export interface IncidentSummary {
  id: string;
  title: string;
  owner: Ref;
  status: "open" | "closed";
  openedAt: string | null;
  closedAt: string | null;
}

export interface IncidentExclusion {
  naturalKey: string;
  field: string | null;
  reason: string;
  displayName: string | null;
}

export interface IncidentRecoveryPoint {
  snapshotId: string;
  snapshot: Ref;
  observedFrom: string | null;
  observedTo: string | null;
  inCompromiseWindow: boolean;
  status: "qualified" | "unsuitable" | "unassessed";
  stale: boolean;
  reasons: string[];
  pinned: boolean;
  assessment: {
    version: number;
    verdict: "clean" | "compromised";
    exclusions: IncidentExclusion[];
    assessedBy: Ref | null;
    assessedAt: string | null;
    fingerprint: string;
  } | null;
}

export interface IncidentDetail {
  incident: IncidentSummary;
  intervals: { id: string; startsAt: string | null; endsAt: string | null; reason: string | null; recordedBy: Ref | null }[];
  pins: { id: string; snapshotId: string; reason: string; pinnedBy: Ref; pinnedAt: string | null }[];
  points: IncidentRecoveryPoint[];
  recommended: string | null;
}

export interface IncidentRecoveryData {
  generatedAt: string;
  incidents: IncidentSummary[];
  selected: IncidentDetail | null;
}

/** One query for every person a page names. An id that no longer resolves keeps its
 * kind and a short id with "no longer readable" — never a bare UUID. */
export async function principalRefs(client: KeelClient, ids: (string | null | undefined)[]): Promise<Map<string, Ref>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const refs = new Map<string, Ref>();
  if (wanted.length === 0) return refs;
  const { rows } = await client.query(
    "SELECT id::text AS id, email, display_name FROM principal WHERE id::text = ANY($1::text[])",
    [wanted],
  );
  for (const row of rows) {
    const id = String(row.id);
    refs.set(id, { kind: "person", id, name: String(row.display_name ?? row.email), href: "/principals" });
  }
  for (const id of wanted) {
    if (!refs.has(id)) refs.set(id, { kind: "person", id, name: `Account ${id.slice(0, 8)} (no longer readable)`, href: null });
  }
  return refs;
}

/** People by principal id for a page that has no other database work (Activity). */
export async function getPrincipalNames(ids: string[]): Promise<Record<string, Ref>> {
  return withClient(async (client) => Object.fromEntries(await principalRefs(client, ids)));
}

export function snapshotName(snapshot: { id: string; observedTo?: string | null; observedFrom?: string | null }, all: { id: string; observedTo?: string | null; observedFrom?: string | null }[] = []): string {
  const when = snapshot.observedTo ?? snapshot.observedFrom ?? null;
  const base = when ? `Snapshot of ${formatTimestamp(when)}` : "Snapshot at an unknown time";
  const sameName = all.filter((other) => (other.observedTo ?? other.observedFrom ?? null) === when && other.id !== snapshot.id);
  // A short id only as a disambiguator suffixed to the name (rule 3).
  return sameName.length ? `${base} · ${snapshot.id.slice(0, 8)}` : base;
}

type RawPoint = Omit<IncidentRecoveryPoint, "snapshot" | "assessment"> & {
  assessment: (Omit<NonNullable<IncidentRecoveryPoint["assessment"]>, "assessedBy" | "exclusions"> & {
    assessedBy: string | null;
    exclusions: { naturalKey: string; field: string | null; reason: string }[];
  }) | null;
};

export async function getIncidentRecoveryData(requestedId?: string): Promise<IncidentRecoveryData> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const rawIncidents = (await listIncidents(client, { tenantRef: ref })) as (Omit<IncidentSummary, "owner"> & { owner: string })[];
    const chosen = rawIncidents.find((incident) => incident.id === requestedId) ?? rawIncidents[0] ?? null;
    const listing = chosen
      ? (await listIncidentRecoveryPoints(client, { tenantRef: ref, incidentId: chosen.id })) as unknown as {
        intervals: { id: string; startsAt: string | null; endsAt: string | null; reason: string | null; recordedBy: string | null }[];
        pins: { id: string; snapshotId: string; reason: string; pinnedBy: string; pinnedAt: string | null }[];
        points: RawPoint[];
        recommended: string | null;
      }
      : null;

    const people = await principalRefs(client, [
      ...rawIncidents.map((incident) => incident.owner),
      ...(listing?.intervals.map((interval) => interval.recordedBy) ?? []),
      ...(listing?.pins.map((pin) => pin.pinnedBy) ?? []),
      ...(listing?.points.map((point) => point.assessment?.assessedBy) ?? []),
    ]);
    const person = (id: string | null) => (id ? people.get(id) ?? null : null);

    // Excluded resources are named from the snapshot that was checked: one query.
    const wanted = listing?.points.flatMap((point) =>
      (point.assessment?.exclusions ?? []).map((exclusion) => ({ snapshotId: point.snapshotId, naturalKey: exclusion.naturalKey }))) ?? [];
    const displayNames = new Map<string, string>();
    if (wanted.length > 0) {
      const { rows } = await client.query(
        `SELECT rv.snapshot_id::text AS snapshot_id, rv.natural_key, rv.payload->>'displayName' AS display_name
           FROM resource_version rv JOIN snapshot s ON s.id = rv.snapshot_id
           JOIN unnest($1::text[], $2::text[]) AS w(snapshot_id, natural_key)
             ON w.snapshot_id = rv.snapshot_id::text AND w.natural_key = rv.natural_key
          WHERE s.tenant_ref = $3`,
        [wanted.map((entry) => entry.snapshotId), wanted.map((entry) => entry.naturalKey), ref],
      );
      for (const row of rows) {
        if (row.display_name) displayNames.set(`${row.snapshot_id}|${row.natural_key}`, String(row.display_name));
      }
    }

    const incidents: IncidentSummary[] = rawIncidents.map((incident) => ({
      ...incident,
      owner: person(incident.owner) ?? { kind: "person", id: "", name: "Unknown owner", href: null },
    }));
    const selectedIncident = chosen ? incidents.find((incident) => incident.id === chosen.id) ?? null : null;
    const points = listing?.points ?? [];
    const selected: IncidentDetail | null = selectedIncident && listing ? {
      incident: selectedIncident,
      intervals: listing.intervals.map((interval) => ({ ...interval, recordedBy: person(interval.recordedBy) })),
      pins: listing.pins.map((pin) => ({ ...pin, pinnedBy: person(pin.pinnedBy) ?? { kind: "person", id: pin.pinnedBy, name: "Unknown", href: null } })),
      points: points.map((point) => ({
        ...point,
        snapshot: { kind: "snapshot", id: point.snapshotId, name: snapshotName({ id: point.snapshotId, observedTo: point.observedTo, observedFrom: point.observedFrom }, points.map((other) => ({ id: other.snapshotId, observedTo: other.observedTo, observedFrom: other.observedFrom }))), href: `/restore?snapshot=${point.snapshotId}` },
        assessment: point.assessment ? {
          ...point.assessment,
          assessedBy: person(point.assessment.assessedBy),
          exclusions: point.assessment.exclusions.map((exclusion) => ({
            ...exclusion, displayName: displayNames.get(`${point.snapshotId}|${exclusion.naturalKey}`) ?? null,
          })),
        } : null,
      })),
      recommended: listing.recommended,
    } : null;
    return { generatedAt: new Date().toISOString(), incidents, selected };
  });
}

/** One incident of this tenant by id, or null (another tenant's incident reads as absent). */
export async function getIncidentSummary(incidentId: string): Promise<{ id: string; title: string } | null> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const incidents = (await listIncidents(client, { tenantRef: ref })) as { id: string; title: string }[];
    const found = incidents.find((incident) => incident.id === incidentId);
    return found ? { id: found.id, title: found.title } : null;
  });
}

export function buildAlerts({
  activeBaseline,
  lastCollection,
  coverage,
  evidence,
}: Pick<
  DashboardData,
  "activeBaseline" | "lastCollection" | "coverage" | "evidence"
>): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  if (!activeBaseline) {
    alerts.push({
      severity: "critical",
      title: "No baseline is active",
      detail: "KEEL cannot tell what changed until a baseline is set.",
    });
  } else if (activeBaseline.resourceCount === 0) {
    alerts.push({
      severity: "critical",
      title: "The active baseline is empty",
      detail: "It holds no resources, so it cannot describe how the tenant should look.",
    });
  }

  if (!lastCollection) {
    alerts.push({
      severity: "critical",
      title: "Nothing has been backed up",
      detail: "KEEL holds no snapshot of this tenant, so there is nothing to restore from.",
    });
  } else if (lastCollection.status !== "complete") {
    alerts.push({
      severity: "warning",
      title: lastCollection.status === "running" ? "The latest backup is still running" : "The latest backup did not finish",
      detail: lastCollection.completedAt
        ? "Its snapshot did not complete successfully."
        : "Its snapshot has no finish time yet.",
    });
  }

  if (coverage.failed > 0) {
    alerts.push({
      severity: "critical",
      title: `${coverage.failed} configuration ${coverage.failed === 1 ? "type" : "types"} failed ${coverage.failed === 1 ? "its" : "their"} last backup`,
      detail: "KEEL does not count a failed read as backed up. Retry the backup or check permissions.",
    });
  }

  if (coverage.stale > 0) {
    alerts.push({
      severity: "warning",
      title: `${coverage.stale} configuration ${coverage.stale === 1 ? "type is" : "types are"} out of date`,
      detail: "They were backed up successfully, but not recently enough for how critical they are. Run a backup.",
    });
  }

  const uncovered = coverage.notCovered + coverage.neverCollected;
  if (uncovered > 0) {
    alerts.push({
      severity: "warning",
      title: `${uncovered} configuration ${uncovered === 1 ? "type is" : "types are"} not backed up`,
      detail: "KEEL knows these configuration types but has no successful backup of them.",
    });
  }

  if (!evidence.ok) {
    alerts.push({
      severity: "critical",
      title: "The audit record failed its integrity check",
      detail: "Who-did-what records cannot be trusted until this is investigated.",
    });
  }

  return alerts;
}

export async function getDashboardData(): Promise<DashboardData> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const active = (await getActiveBaseline(client, { tenantRef: ref })) as
      | UnknownRecord
      | null;
    const baselines = await baselinesFor(client, ref);
    const activeBaseline = active
      ? baselines.find((candidate) => candidate.id === String(active.id)) ??
        normalizeBaseline({ ...active, resource_count: 0 })
      : null;
    const lastCollectionRaw = (await getLastCollection(client, {
      tenantRef: ref,
    })) as UnknownRecord | null;
    const evidenceRaw = (await getEvidenceIntegrity(client, {
      tenantRef: ref,
    })) as { ok: boolean; chainLength: number };
    const drift = await activeDriftFor(client, ref, activeBaseline?.id ?? null);
    const rawCoverage = await rawCoverageReport(client, ref);
    const coverageData = await coverageFor(client, ref, rawCoverage);
    // Task-129: the Overview sentence comes from this same report, never a constant.
    const headline = protectionHeadline(rawCoverage.types as never) as ProtectionHeadline;
    const generatedAt = new Date();
    const driftTrend = await driftTrendFor(client, ref, activeBaseline?.id ?? null, generatedAt);

    const openDriftByBlastRadius = [...new Set([
      ...BLAST_RADIUS_ORDER,
      ...drift.map((item) => item.blastRadius),
    ])]
      .map((blastRadius) => ({
        blastRadius,
        count: drift.filter((item) => item.blastRadius === blastRadius).length,
      }))
      .filter((item) => item.count > 0 || BLAST_RADIUS_ORDER.includes(item.blastRadius));
    const lastCollection = lastCollectionRaw
      ? {
          completedAt: iso(lastCollectionRaw.completedAt),
          status: String(lastCollectionRaw.status),
        }
      : null;
    const data: DashboardData = {
      generatedAt: generatedAt.toISOString(),
      activeBaseline,
      lastCollection,
      lastCompletedCollectionAt: coverageData.snapshot?.completedAt ?? null,
      openDriftByBlastRadius,
      openDriftTotal: drift.length,
      driftTrend,
      coverage: coverageData.summary,
      evidence: {
        ok: Boolean(evidenceRaw.ok),
        chainLength: Number(evidenceRaw.chainLength),
      },
      alerts: [],
      headline,
    };

    data.alerts = buildAlerts(data);
    return data;
  });
}

// Roadmap task-73: measured freshness, recoverable point, recovery time and the
// recovery context around them. Every read is pinned to this portal's tenant; the
// numbers are the engine's (engine/coverage/recoveryMetrics.mjs), never recomputed here.
export async function getResilienceData(): Promise<ResilienceData> {
  const ref = tenantRef();
  const now = new Date();
  const { manifest, source } = readRecoveryManifest();
  const storage = { ...(storageResidency({ manifest }) as Omit<StorageResidency, "source">), source };
  return withClient(async (client) => {
    const metrics = (await loadRecoveryMetrics(client, {
      tenantRef: ref,
      requiredTypes: DESCRIPTORS.map((descriptor) => descriptor.type),
      now,
    })) as RecoveryMetrics;
    const open = ((await listIncidents(client, { tenantRef: ref })) as { id: string; title: string; status: string; openedAt: string | null }[])
      .filter((incident) => incident.status === "open");
    const incidents: IncidentPointSummary[] = [];
    for (const incident of open) {
      const listing = (await listIncidentRecoveryPoints(client, { tenantRef: ref, incidentId: incident.id })) as unknown as {
        pins: unknown[];
        points: RawPoint[];
        recommended: string | null;
      };
      const point = listing.points.find((candidate) => candidate.snapshotId === listing.recommended) ?? null;
      incidents.push({
        incident: { id: incident.id, title: incident.title, status: incident.status, openedAt: incident.openedAt },
        recommended: point ? { snapshotId: point.snapshotId, collectedAt: point.observedFrom ?? point.observedTo } : null,
        pins: listing.pins.length,
      });
    }
    return { generatedAt: now.toISOString(), metrics, incidents, storage };
  });
}

// Roadmap task-94: emergency account readiness and the usage canary's state. The
// page guard runs first; the engine reader is pinned to this tenant and reads KEEL's
// own tables only.
export async function getReadinessData(): Promise<ReadinessData> {
  const ref = tenantRef();
  return withClient(async (client) => (await loadBreakGlassReadiness(client, { tenantRef: ref, now: new Date() })) as unknown as ReadinessData);
}
