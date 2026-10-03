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
  // Roadmap task-107: the expansion batch the type belongs to. Null on legacy reports.
  expansion?: TypeExpansion | null;
}

export type ExpansionStatus = "qualified-subset" | "manual" | "unsupported" | "research-needed";
export type RestoreScope = "none" | "partial" | "full";

export interface TypeExpansion {
  batch: string;
  batchLabel: string;
  status: ExpansionStatus;
  // Derived from registered operations only, never declared.
  restoreScope: RestoreScope;
  reason: string;
  // Roadmap task-108: subtypes the registered writes are limited to (e.g.
  // "custom"). Empty when writes are not subtype-bound; absent on older reports.
  qualifiedSubtypes?: string[];
  // Roadmap task-109: what cannot be recovered for the type, configuration and
  // relationships alike. null when the type has not been assessed; absent on
  // older reports. Never a coverage percentage.
  unrecoverable?: UnrecoverableItem[] | null;
}

export interface UnrecoverableItem {
  kind: "configuration" | "relationship";
  name: string;
  reason: string;
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
  // Roadmap task-130: who set it, resolved to a name (absent where not resolved).
  setByRef?: Ref;
  // Roadmap task-87: version chain, what it captured and what changed since.
  version?: number;
  supersedesId?: string | null;
  supersededById?: string | null;
  supersededAt?: string | null;
  capture?: BaselineCapture;
  changesSinceCapture?: BaselineChanges;
}

// Roadmap task-87. The age of a baseline is measured from capturedAt, when its source
// collection finished; never from the time the page was read.
export interface BaselineCapture {
  basis: "source-snapshot" | "legacy-resource-versions" | "unknown";
  capturedAt: string | null;
  ageMs: number | null;
  sourceSnapshotId: string | null;
  window: { startedAt: string | null; completedAt: string | null } | null;
  types: string[];
}

export interface BaselineChanges {
  state: "compared" | "not-comparable" | "no-collection";
  comparedSnapshotId: string | null;
  comparedAt: string | null;
  added: number;
  modified: number;
  removed: number;
  total: number;
  reason?: string;
}

export interface ComplianceEvidence {
  resourceType: string;
  window: { startedAt: string | null; endedAt: string | null };
  snapshotId: string | null;
  completedAt: string | null;
}

export interface ComplianceChangeLink {
  id: string;
  naturalKey: string;
  resourceType: string;
  changeType: string;
  snapshotId: string;
  detectedAt: string | null;
}

export interface CompliancePlanLink {
  requestId: string;
  dryRunId: string;
  snapshotId: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface ComplianceLinks<T> {
  state: "linked" | "mismatch" | "none";
  linked: T[];
  mismatched: T[];
}

export interface ComplianceFinding {
  id: string;
  controlId: string;
  title: string | null;
  framework: string;
  edition: string;
  profile: string;
  evaluatorVersion: number;
  verdict: "pass" | "fail" | "unknown" | "not-applicable";
  reason: string | null;
  evaluatedAt: string | null;
  evidenceSeq: string | null;
  exceptionState: "none" | "authorized" | "expired" | "incomplete";
  exception: {
    id: string;
    owner: string | null;
    reason: string | null;
    grantedBy: string | null;
    grantedAt: string | null;
    expiresAt: string | null;
  } | null;
  exposed: boolean;
  evidence: ComplianceEvidence[];
  links: {
    backup: ComplianceLinks<ComplianceEvidence>;
    change: ComplianceLinks<ComplianceChangeLink>;
    restorePlan: ComplianceLinks<CompliancePlanLink>;
  };
}

export interface ComplianceSummary {
  controls: number;
  exposed: number;
  excepted: number;
  expiredExceptions: number;
  incompleteExceptions: number;
  passing: number;
  unknown: number;
  notApplicable: number;
}

export interface StorageResidency {
  configured: boolean;
  provider: string | null;
  region: string | null;
  boundary: string | null;
  immutability: "unknown" | "unsupported" | "fixture-tested" | "live-qualified";
  generatedAt: string | null;
  certifies: null;
  // Where the residency was read from (the recovery manifest path), or null.
  source: string | null;
}

export interface ComplianceData {
  generatedAt: string;
  findings: ComplianceFinding[];
  summary: ComplianceSummary;
  storage: StorageResidency;
  activeBaseline: BaselineRecord | null;
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
  // Task 91: who made the change, from audit evidence, and where a roll back of it
  // would be routed. Absent when the reader did not compute it.
  attribution?: ChangeAttribution | null;
}

// engine/identity/attribution.mjs#attributeChanges plus engine/govern/approvals.mjs#routeApproval.
export interface ChangeAttribution {
  verdict: "exact" | "plausible" | "unknown";
  reason: string;
  // id is null when the account is outside the reader's entities; name is null when
  // KEEL holds no collected user or app with that id.
  actors: Array<{ kind: "user" | "servicePrincipal"; id: string | null; name: string | null }>;
  evidence: Array<{ sourceEventId: string; occurredAt: string; operation: string; activity: string | null; fields: string[] }>;
  resourceObjectId: string | null;
  window: { from: string; until: string };
  coverage: { audit: string; signIn: string };
  route: {
    route: "entity" | "central" | "refused";
    reason?: string;
    entityCode?: string;
    approverCount: number;
    routedAt: string;
  } | null;
}

export interface DriftData {
  generatedAt: string;
  baseline: BaselineRecord | null;
  items: DriftRecord[];
  // Task 90: present when the reader is entity-scoped; the list and the baseline's
  // resource count then cover only these entities' resources.
  scope?: { central: false; entities: string[] };
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
  // Roadmap task-129: the memorable number, computed by the engine from the coverage
  // reader and restore-drill evidence (engine/coverage/protectionHeadline.mjs).
  headline: ProtectionHeadline;
}

export interface ProtectionHeadline {
  state: "collection" | "proven" | "unproven";
  tone: "good" | "attention" | "critical";
  headline: string;
  sentence: string;
  action: { label: string; href: string } | null;
  counts: { backedUp: number; restorable: number; failing: number; failed: number; stale: number; neverCollected: number };
  lastProvenRestoreAt: string | null;
  failingSince: string | null;
}

// Portal experience contract, rule 2: a field that holds another object's id is
// rendered as that object's name. Readers resolve it server-side into a Ref.
export interface Ref {
  kind: string;
  id: string;
  name: string;
  href: string | null;
}
