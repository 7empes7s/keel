export type ProtectionState =
  | "protected"
  | "partially-protected"
  | "read-only"
  | "unprotectable"
  | "failed"
  | "not-covered";

export type Fidelity = "full" | "partial" | "read-only" | "unprotectable";

export type CoverageOutcome =
  | "complete"
  | "complete-empty"
  | "partial"
  | "failed"
  | "not-requested";

export interface CoverageOutcomeDetail {
  httpStatus: number | null;
  graphCode: string | null;
  message: string | null;
  endpoint: string | null;
  apiVersion: string | null;
  pagesCompleted: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

// Evidence-backed operation capability (roadmap task-52), surfaced per
// operation so a claim level is never collapsed into a single boolean —
// declared/fixture-tested/live-qualified/unsupported/unknown all render as
// distinct, literal labels.
export type CapabilityClaim =
  | "declared"
  | "fixture-tested"
  | "live-qualified"
  | "unsupported"
  | "unknown";

export interface WriteOperationCapability {
  claim: CapabilityClaim;
  credentialMode: "collector" | "restorer" | null;
  idOutcome: string | null;
  handler: string | null;
  proofRef: string | null;
  projection: "reviewed-empty" | "unreviewed" | "has-rules";
}

export interface WriteCapabilitySummary {
  resourceType: string;
  operations: {
    create: WriteOperationCapability;
    update: WriteOperationCapability;
    delete: WriteOperationCapability;
    "restore-soft-deleted": WriteOperationCapability;
  };
}

// Roadmap task-63: the explicit recovery decision for a catalogue type. Legacy
// reports without it read as null, never as "automated".
export type QualificationDecision = "automated" | "manual" | "unknown";

export interface TypeQualification {
  decision: QualificationDecision;
  reason: string | null;
  softRestoreCandidate: boolean;
  // Per write operation that rewrites references: is remapping to a different id proven?
  remapping: Record<string, boolean>;
}

// Prerequisite diagnosis (roadmap task-53): a confirmed-missing license,
// consent scope or role, additional to (never a replacement for) the raw
// outcome/detail above.
export type DiagnosisState =
  | "missing-license"
  | "disabled-plan"
  | "missing-scope"
  | "missing-role"
  | "unknown";

export interface CoverageDiagnosis {
  diagnosis: DiagnosisState;
  reason?: string;
  original: { httpStatus: number | null; graphCode: string | null };
  confirmed?: Record<string, unknown>;
}

export interface DeclaredEndpoint {
  path: string;
  apiVersion: string;
}

// The versioned observation anchoring this entry (roadmap task-45), linking
// this row to the same evidence a backup/drift/benchmark view would cite.
export interface CoverageObservation {
  observationId: string;
  window: { startedAt: string; endedAt: string } | null;
  completeness: string;
  evidenceLevel: string;
}

export interface CoverageType {
  type: string;
  reportStatus: "covered" | "failed" | "not-covered" | "never-collected";
  protectionState: ProtectionState;
  stale: boolean;
  itemCount: number | null;
  lastCollectedAt: string | null;
  adapter: string | null;
  outcome: CoverageOutcome | null;
  detail: CoverageOutcomeDetail | null;
  fidelity: {
    declared: Fidelity | null;
    measured: Fidelity | null;
    verifiedAt: string | null;
  };
  criticality: string | null;
  blastRadius: string | null;
  remappable: boolean | null;
  // The rest are optional: existing fixtures built before roadmap task-54
  // (e.g. portal/test/staleness.test.ts) omit them, and every consumer must
  // treat an absent field exactly like an explicit null.
  declaredEndpoint?: DeclaredEndpoint | null;
  irrecoverableFields?: string[] | null;
  relationshipCompleteness?: "unknown" | "partial";
  diagnosis?: CoverageDiagnosis | null;
  writeCapability?: WriteCapabilitySummary | null;
  qualification?: TypeQualification | null;
  observation?: CoverageObservation | null;
}

export interface CoverageSummary {
  covered: number;
  failed: number;
  notCovered: number;
  neverCollected: number;
  stale: number;
  total: number;
}

export interface CoverageData {
  generatedAt: string;
  snapshot: {
    id: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
  summary: CoverageSummary;
  types: CoverageType[];
}

export interface BaselineRecord {
  id: string;
  label: string | null;
  description: string | null;
  setAt: string;
  setBy: string;
  active: boolean;
  resourceCount: number;
}

export interface DriftRecord {
  id: string;
  naturalKey: string;
  resourceType: string;
  changeType: "added" | "modified" | "removed";
  blastRadius: string;
  detectedAt: string;
  // The per-deviation before/after already computed by govern/diffSnapshots.mjs and
  // stored on the drift row (baseline state vs observed state, null on add/remove).
  before: unknown;
  after: unknown;
}

export interface DriftData {
  generatedAt: string;
  baseline: BaselineRecord | null;
  items: DriftRecord[];
}

export interface BaselinesData {
  generatedAt: string;
  baselines: BaselineRecord[];
}

export interface DashboardAlert {
  severity: "critical" | "warning" | "notice";
  title: string;
  detail: string;
}

export interface DashboardData {
  generatedAt: string;
  activeBaseline: BaselineRecord | null;
  lastCollection: {
    completedAt: string | null;
    status: string;
  } | null;
  lastCompletedCollectionAt: string | null;
  openDriftByBlastRadius: Array<{ blastRadius: string; count: number }>;
  openDriftTotal: number;
  // Drift rows detected per UTC day against the active baseline, oldest first, one
  // entry per day for the trend window (zero-filled), so the sparkline is to scale.
  driftTrend: Array<{ day: string; count: number }>;
  coverage: CoverageSummary;
  evidence: { ok: boolean; chainLength: number };
  alerts: DashboardAlert[];
}
