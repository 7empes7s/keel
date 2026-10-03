import { ago, displayEnum, formatTimestamp } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import type {
  BaselineCapture,
  BaselineChanges,
  BaselineRecord,
  ComplianceData,
  ComplianceFinding,
  StorageResidency,
} from "@/lib/types";

// Roadmap task-87: baseline age, compliance findings and storage residency in words.
// Every sentence is built from reader fields; identifiers stay in the record layer.

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/** How old the baseline's evidence is: measured from its capture, never from the page read. */
export function captureSentence(capture: BaselineCapture | undefined, now: string): string {
  if (!capture || capture.basis === "unknown" || !capture.capturedAt) {
    return "When its backup was collected is not recorded.";
  }
  const covers = capture.types.length ? `, covering ${plural(capture.types.length, "configuration type")}` : "";
  const from = capture.basis === "legacy-resource-versions" ? "read from the backups its resources came from" : "from one complete backup";
  return `Captured ${ago(capture.capturedAt, now)} ${from}${covers}.`;
}

/** What the capture covered, without repeating its age (the table shows that once). */
export function captureScope(capture: BaselineCapture | undefined): string {
  if (!capture || capture.basis === "unknown" || !capture.capturedAt) return "What it covered is not recorded.";
  const from = capture.basis === "legacy-resource-versions" ? "Read from the backups its resources came from" : "From one complete backup";
  return `${from}, covering ${plural(capture.types.length, "configuration type")}.`;
}

export function captureAge(capture: BaselineCapture | undefined, now: string): string {
  return capture?.capturedAt ? ago(capture.capturedAt, now) : "Not recorded";
}

export function changesSentence(changes: BaselineChanges | undefined, { short = false } = {}): string {
  if (!changes) return "Not compared yet.";
  if (changes.state === "no-collection") return "No complete backup to compare with yet.";
  if (changes.state === "not-comparable") return "Cannot be compared with the latest backup; the reason is in Technical details.";
  if (changes.total === 0) return short ? "No changes." : "No changes since capture.";
  const parts = [
    changes.added ? `${changes.added} added` : null,
    changes.modified ? `${changes.modified} changed` : null,
    changes.removed ? `${changes.removed} removed` : null,
  ].filter(Boolean);
  return `${plural(changes.total, "change")}${short ? "" : " since capture"} (${parts.join(", ")}).`;
}

export function baselineState(baseline: BaselineRecord): string {
  if (baseline.supersededById || baseline.supersededAt) return "Replaced by a newer version";
  return baseline.active ? "Active" : "Not active";
}

/** The Baselines page verdict: the active baseline and how old its capture is. */
export function baselinesVerdict(active: BaselineRecord | null, now: string): string {
  if (!active) return "No baseline is active, so KEEL cannot tell what changed.";
  const name = active.label ?? "Unnamed baseline";
  if (!active.capture?.capturedAt) return `The active baseline is “${name}”; when its backup was collected is not recorded.`;
  return `The active baseline is “${name}”, captured ${ago(active.capture.capturedAt, now)}.`;
}

export function versionLabel(baseline: BaselineRecord): string {
  return `Version ${baseline.version ?? 1}`;
}

/** The newest complete backup a baseline could be re-captured from, if any is newer. */
export function resnapshotSource<T extends { id: string; completedAt: string | null }>(
  baseline: BaselineRecord,
  snapshots: T[],
): T | null {
  if (baseline.supersededById || baseline.supersededAt) return null;
  const newest = snapshots[0] ?? null;
  if (!newest?.completedAt) return null;
  const captured = baseline.capture?.capturedAt;
  if (newest.id === baseline.capture?.sourceSnapshotId) return null;
  if (captured && new Date(newest.completedAt) <= new Date(captured)) return null;
  return newest;
}

/* ---------------------------------------------------------------- findings -- */

export function controlName(finding: ComplianceFinding): string {
  return finding.title ?? "A control KEEL no longer holds";
}

export function complianceVerdict(data: ComplianceData): { text: string; tone: "good" | "attention" | "critical" } {
  const { summary } = data;
  if (summary.controls === 0) return { text: "No control has been checked on this tenant yet.", tone: "attention" };
  if (summary.exposed > 0) {
    const expired = summary.expiredExceptions
      ? `, including ${summary.expiredExceptions === 1 ? "one" : summary.expiredExceptions.toLocaleString("en-GB")} whose exception expired`
      : "";
    return {
      text: `${plural(summary.exposed, "control fails", "controls fail")}${expired}.`,
      tone: summary.expiredExceptions || summary.exposed > 1 ? "critical" : "attention",
    };
  }
  if (summary.unknown > 0) {
    return { text: `No control fails; ${plural(summary.unknown, "control")} could not be checked.`, tone: "attention" };
  }
  return { text: `All ${plural(summary.controls, "checked control")} pass or have a current exception.`, tone: "good" };
}

export function findingStatus(finding: ComplianceFinding): string {
  if (finding.verdict === "fail" && finding.exceptionState === "authorized") return "Fails, with a current exception";
  return displayEnum("controlVerdict", finding.verdict);
}

export function findingTone(finding: ComplianceFinding): "pill-bad" | "pill-warn" | "pill-ok" | "pill-neutral" {
  if (finding.exposed) return "pill-bad";
  if (finding.verdict === "unknown" || finding.exceptionState === "authorized") return "pill-warn";
  if (finding.verdict === "pass") return "pill-ok";
  return "pill-neutral";
}

export function exceptionSentence(finding: ComplianceFinding, now: string): string | null {
  const exception = finding.exception;
  if (!exception) return null;
  const owner = exception.owner ?? "no named owner";
  switch (finding.exceptionState) {
    case "authorized":
      return `Exception owned by ${owner} until ${formatTimestamp(exception.expiresAt)}: ${exception.reason}`;
    case "expired":
      return `The exception owned by ${owner} expired ${ago(exception.expiresAt, now)}, so this finding is open again.`;
    case "incomplete":
      return "An exception was recorded without an owner or an expiry, so it does not hide this finding.";
    default:
      return null;
  }
}

export function evidenceSentence(finding: ComplianceFinding, now: string): string {
  const { backup } = finding.links;
  if (backup.state === "none") return "This check rests on no stored backup.";
  if (backup.state === "mismatch") {
    return "No stored backup matches the collection this check used, so it is not linked to one.";
  }
  const newest = backup.linked
    .map((entry) => entry.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  return `Checked against the backup collected ${ago(newest, now)}.`;
}

export function changeLinkSentence(finding: ComplianceFinding): string | null {
  const { change } = finding.links;
  if (change.state === "none") return null;
  const linked = change.linked.length
    ? `${plural(change.linked.length, "open change")} in the same backup.`
    : null;
  const mismatched = change.mismatched.length
    ? `${plural(change.mismatched.length, "open change")} to these types ${change.mismatched.length === 1 ? "comes" : "come"} from a different backup, so ${change.mismatched.length === 1 ? "it is" : "they are"} not linked.`
    : null;
  return [linked, mismatched].filter(Boolean).join(" ");
}

export function planLinkSentence(finding: ComplianceFinding): string | null {
  const { restorePlan } = finding.links;
  if (restorePlan.state === "none") return null;
  const linked = restorePlan.linked.length
    ? `${plural(restorePlan.linked.length, "restore", "restores")} waiting for approval ${restorePlan.linked.length === 1 ? "uses" : "use"} the same backup.`
    : null;
  const mismatched = restorePlan.mismatched.length
    ? `${plural(restorePlan.mismatched.length, "restore", "restores")} waiting for approval ${restorePlan.mismatched.length === 1 ? "uses" : "use"} a different backup, so ${restorePlan.mismatched.length === 1 ? "it is" : "they are"} not linked.`
    : null;
  return [linked, mismatched].filter(Boolean).join(" ");
}

export function findingTypes(finding: ComplianceFinding): string {
  const types = [...new Set(finding.evidence.map((entry) => entry.resourceType))];
  return types.length ? types.map(typeName).join(", ") : "no configuration type";
}

/** Failing findings first (open before excepted), then unknown, then the rest. */
export function orderFindings(findings: ComplianceFinding[]): ComplianceFinding[] {
  const rank = (finding: ComplianceFinding) => (finding.exposed ? 0
    : finding.verdict === "fail" ? 1
      : finding.verdict === "unknown" ? 2
        : 3);
  return [...findings].sort((left, right) => rank(left) - rank(right) || controlName(left).localeCompare(controlName(right)));
}

/* ----------------------------------------------------------------- storage -- */

const PROVIDER_WORDS: Record<string, string> = {
  "local-disk": "local disk",
  "s3-compatible": "S3-compatible object storage",
};

export function storageSentence(storage: StorageResidency): string {
  if (!storage.configured || !storage.provider) {
    return "Where backups are stored is not configured, so KEEL cannot say where they are kept.";
  }
  const where = PROVIDER_WORDS[storage.provider] ?? storage.provider.replaceAll("-", " ");
  return `Backups are configured to be stored on ${where}${storage.region ? ` in ${storage.region}` : ""}.`;
}

export function immutabilitySentence(storage: StorageResidency): string {
  switch (storage.immutability) {
    case "unsupported":
      return "This storage cannot lock backups against deletion.";
    case "live-qualified":
      return "Locking backups against deletion is proven on this tenant.";
    default:
      return "Locking backups against deletion is not yet proven on this tenant.";
  }
}

export const NOT_A_CERTIFICATION =
  "This states where backups are kept. It is not a certification of compliance with any regulation.";
