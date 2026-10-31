import { backupHealth, type BackupHealth } from "@/lib/protect-view";
import type { CoverageType } from "@/lib/types";

// The coverage report lists the Microsoft 365 workloads (Exchange, SharePoint and
// OneDrive, Teams, Purview, Power Platform) beside the Entra ID and Intune types, never
// inside them (engine/coverage/report.mjs `workloads`). What's protected shows every
// service, so each workload becomes one more kind on that page. Pure: no database here.

type UnknownRecord = Record<string, unknown>;

const USABLE = new Set(["complete", "complete-empty", "partial"]);

function iso(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function reportStatus(outcome: string): CoverageType["reportStatus"] {
  if (USABLE.has(outcome)) return "covered";
  if (outcome === "failed") return "failed";
  if (outcome === "never-collected") return "never-collected";
  // "disabled": the workload is switched off until a live read from the tenant is checked.
  return "not-covered";
}

/**
 * One workload from the coverage report as a kind on What's protected. The workload
 * code (exchange-mail-flow, teams-org-policies…) is the kind's type, so the taxonomy
 * names it and places it in its service. `canRestore` says whether Keel declares any
 * write for it (engine/coverage/coverageDoc.mjs workloadRestoreGuide).
 */
export function workloadKind(raw: UnknownRecord, canRestore: boolean): CoverageType {
  const outcome = typeof raw.status === "string" ? raw.status : "never-collected";
  const status = reportStatus(outcome);
  const observation = (raw.observation ?? null) as UnknownRecord | null;
  const ran = status === "covered" || status === "failed";
  const declared = canRestore ? "partial" : "read-only";
  return {
    type: String(raw.workload),
    reportStatus: status,
    protectionState: status === "covered" ? (canRestore ? "partially-protected" : "read-only") : status === "failed" ? "failed" : "not-covered",
    stale: false,
    itemCount: ran && typeof raw.resources === "number" ? raw.resources : null,
    lastCollectedAt: ran ? iso(observation?.endedAt) : null,
    adapter: String(raw.workload),
    outcome: USABLE.has(outcome) || outcome === "failed" ? (outcome as CoverageType["outcome"]) : null,
    detail: null,
    fidelity: { declared, measured: null, verifiedAt: null },
    criticality: null,
    blastRadius: null,
    remappable: null,
  };
}

/** Every workload in the report as a kind; a report without workloads gives none. */
export function workloadKinds(workloads: unknown, restorable: ReadonlySet<string>): CoverageType[] {
  if (!Array.isArray(workloads)) return [];
  return (workloads as UnknownRecord[])
    .filter((raw) => raw && typeof raw.workload === "string")
    .map((raw) => workloadKind(raw, restorable.has(String(raw.workload))));
}

const HEADLINE_STATUS: Record<BackupHealth, HeadlineEntry["status"]> = {
  ok: "covered", empty: "covered", stale: "covered", failed: "failed", never: "never-collected",
  "not-collected": "not-covered", unavailable: "not-covered",
};

/**
 * Every kind (the report's types and workloads, as on What's protected) in the shape the
 * engine's protection headline reads, its status taken from backupHealth so the Overview
 * sentence counts exactly what the coverage buckets count (lib/protect-view.ts
 * coverageBuckets): a partly done read is failed, and a kind not switched on or not on
 * this tenant is left out. Restore evidence (fidelity, writers) comes from the raw entry.
 */
export function headlineEntries(rawTypes: readonly unknown[], kinds: readonly CoverageType[]): HeadlineEntry[] {
  const raw = new Map((rawTypes as UnknownRecord[]).map((entry) => [String(entry.type), entry]));
  return kinds.map((kind) => {
    const health = backupHealth(kind);
    const base = raw.get(kind.type) ?? {
      type: kind.type,
      lastCollectedAt: kind.lastCollectedAt,
      fidelity: { declared: kind.fidelity?.declared ?? null, verifiedBy: null },
    };
    return { ...base, type: kind.type, status: HEADLINE_STATUS[health], outcome: kind.outcome, stale: health === "stale" } as HeadlineEntry;
  });
}

export interface HeadlineEntry {
  type: string;
  status: "covered" | "failed" | "never-collected" | "not-covered";
  outcome: CoverageType["outcome"];
  stale: boolean;
  lastCollectedAt?: unknown;
  fidelity?: unknown;
}
