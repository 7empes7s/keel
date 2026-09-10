export type ProtectionState =
  | "protected"
  | "partially-protected"
  | "read-only"
  | "unprotectable"
  | "failed"
  | "not-covered";

export type Fidelity = "full" | "partial" | "read-only" | "unprotectable";

export interface CoverageType {
  type: string;
  reportStatus: "covered" | "failed" | "not-covered" | "never-collected";
  protectionState: ProtectionState;
  stale: boolean;
  itemCount: number | null;
  lastCollectedAt: string | null;
  adapter: string | null;
  fidelity: {
    declared: Fidelity | null;
    measured: Fidelity | null;
    verifiedAt: string | null;
  };
  criticality: string | null;
  blastRadius: string | null;
  remappable: boolean | null;
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
  coverage: CoverageSummary;
  evidence: { ok: boolean; chainLength: number };
  alerts: DashboardAlert[];
}
