import { buildCoverageReport } from "../../engine/coverage/report.mjs";
import { DESCRIPTORS } from "../../engine/collect/descriptors.mjs";
import { listBaselines } from "../../engine/govern/baseline.mjs";
import {
  getActiveBaseline,
  listOpenDrift,
} from "../../engine/store/governance.mjs";
import { connect } from "../../engine/store/db.mjs";
import {
  getEvidenceIntegrity,
  getLastCollection,
} from "../../status/queries.mjs";
import { CATALOG } from "../../tools/tenant-probe/catalog.mjs";

import { BLAST_RADIUS_ORDER } from "@/lib/presentation";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type {
  BaselineRecord,
  BaselinesData,
  CapabilityClaim,
  CoverageData,
  CoverageDiagnosis,
  CoverageObservation,
  CoverageType,
  DashboardAlert,
  DashboardData,
  DeclaredEndpoint,
  DiagnosisState,
  DriftData,
  DriftRecord,
  Fidelity,
  ProtectionState,
  WriteCapabilitySummary,
  WriteOperationCapability,
} from "@/lib/types";

interface KeelClient {
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

async function coverageFor(client: KeelClient, ref: string): Promise<CoverageData> {
  const raw = (await buildCoverageReport(client, {
    tenantRef: ref,
    catalog: CATALOG,
    descriptors: DESCRIPTORS,
    now: new Date(),
  })) as UnknownRecord;
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

export async function getCoverageData(): Promise<CoverageData> {
  const ref = tenantRef();
  return withClient((client) => coverageFor(client, ref));
}

export async function getBaselinesData(): Promise<BaselinesData> {
  const ref = tenantRef();
  return withClient(async (client) => ({
    generatedAt: new Date().toISOString(),
    baselines: await baselinesFor(client, ref),
  }));
}

export async function getDriftData(): Promise<DriftData> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const active = (await getActiveBaseline(client, { tenantRef: ref })) as
      | UnknownRecord
      | null;
    const baselines = await baselinesFor(client, ref);
    const baseline = active
      ? baselines.find((candidate) => candidate.id === String(active.id)) ??
        normalizeBaseline({ ...active, resource_count: 0 })
      : null;
    const items = await activeDriftFor(client, ref, baseline?.id ?? null);

    return { generatedAt: new Date().toISOString(), baseline, items };
  });
}

// Plan task 17 (portal-design §4.1): the restore surface lists the resources an
// operator can select from one snapshot. The filter mirrors cli/keel-restore.mjs —
// users and authentication strength policies are read-only in M1 and never written —
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
         AND rv.resource_type NOT IN ('user', 'authenticationStrengthPolicy')
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
      title: "No active baseline",
      detail: "Drift cannot be evaluated until a baseline is active.",
    });
  } else if (activeBaseline.resourceCount === 0) {
    alerts.push({
      severity: "critical",
      title: "Active baseline is empty",
      detail: "It contains zero resources and cannot represent tenant state.",
    });
  }

  if (!lastCollection) {
    alerts.push({
      severity: "critical",
      title: "No collection exists",
      detail: "KEEL has no recorded tenant snapshot.",
    });
  } else if (lastCollection.status !== "complete") {
    alerts.push({
      severity: "warning",
      title: `Latest collection is ${lastCollection.status.toUpperCase()}`,
      detail: lastCollection.completedAt
        ? "The latest snapshot did not complete successfully."
        : "The latest snapshot has no completion timestamp.",
    });
  }

  if (coverage.failed > 0) {
    alerts.push({
      severity: "critical",
      title: `${coverage.failed} ${coverage.failed === 1 ? "type" : "types"} FAILED collection`,
      detail: "The last completed collection returned zero items. KEEL does not count this as coverage.",
    });
  }

  if (coverage.stale > 0) {
    alerts.push({
      severity: "warning",
      title: `${coverage.stale} ${coverage.stale === 1 ? "catalog type is" : "catalog types are"} stale`,
      detail: "Run a collection for the stale types; they were collected successfully but are no longer recent enough for their tier.",
    });
  }

  const uncovered = coverage.notCovered + coverage.neverCollected;
  if (uncovered > 0) {
    alerts.push({
      severity: "warning",
      title: `${uncovered} catalog ${uncovered === 1 ? "type is" : "types are"} not covered`,
      detail: "These known configuration surfaces have no successful non-zero collection.",
    });
  }

  if (!evidence.ok) {
    alerts.push({
      severity: "critical",
      title: "Evidence chain integrity failed",
      detail: "Governance evidence cannot be trusted until the chain is investigated.",
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
    const coverageData = await coverageFor(client, ref);

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
      generatedAt: new Date().toISOString(),
      activeBaseline,
      lastCollection,
      lastCompletedCollectionAt: coverageData.snapshot?.completedAt ?? null,
      openDriftByBlastRadius,
      openDriftTotal: drift.length,
      coverage: coverageData.summary,
      evidence: {
        ok: Boolean(evidenceRaw.ok),
        chainLength: Number(evidenceRaw.chainLength),
      },
      alerts: [],
    };

    data.alerts = buildAlerts(data);
    return data;
  });
}
