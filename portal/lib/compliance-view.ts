import type { IconName } from "@/components/shell/icons";
import { typeService } from "@/lib/baselines-view";
import { changeName } from "@/lib/changes-view";
import type { RiskTone } from "@/lib/menu-status";
import { ago, formatTimestamp } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { type EngineRef, personLabel } from "@/lib/sentences";
import type { CloudService } from "@/lib/services";
import type {
  BaselineCapture,
  BaselineChanges,
  BaselineRecord,
  ComplianceData,
  ComplianceFinding,
  ComplianceSummary,
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
  if (!active) return "No baseline is active, so Keel cannot tell what changed.";
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

// Compliance (portal audit, pick A on a desktop, B on a phone): each control in plain
// words. Microsoft's terms and the registry wording stay in Technical details.

interface ControlWords {
  title: string;
  // The phone tile's two-to-four words.
  short: string;
  what: string;
  why: string;
  types: string[];
}

const CONTROL_WORDS: Record<string, ControlWords> = {
  "keel-custom.role-assignment.admin-count-at-most": {
    title: "No more than 5 people hold the top admin role",
    short: "At most 5 top admins",
    what: "Counts the people who hold the top admin role (Global Administrator) in the newest backup.",
    why: "Every extra top admin is one more account that can change everything if it is taken over.",
    types: ["roleAssignment"],
  },
  "keel-custom.named-location.no-untrusted-all-countries": {
    title: "No trusted location trusts unknown countries",
    short: "No trusted unknown countries",
    what: "Looks for a trusted location that also takes in traffic from countries that cannot be told.",
    why: "Sign-ins from places nobody can name would count as coming from a trusted network.",
    types: ["namedLocation"],
  },
  "keel-custom.group.role-assignable-not-synced": {
    title: "Groups that grant admin roles are not copied from on-premises",
    short: "Admin groups not copied",
    what: "Looks for groups that can hold admin roles and are kept in step with your on-premises directory.",
    why: "Whoever takes over that group on-premises gets a cloud admin role with it.",
    types: ["group"],
  },
  "keel-custom.conditional-access.block-legacy": {
    title: "Old sign-in methods are blocked",
    short: "Old sign-in blocked",
    what: "Looks for a sign-in rule that turns on blocking of old sign-in methods.",
    why: "Old sign-in methods skip multi-factor sign-in, so a stolen password is enough.",
    types: ["conditionalAccessPolicy"],
  },
};

const CHECK_WORDS: Record<string, string> = {
  roleAssignment: "admin role assignments",
  namedLocation: "trusted locations",
  group: "groups",
  conditionalAccessPolicy: "sign-in rules",
};

function kindWords(type: string): string {
  return CHECK_WORDS[type] ?? typeName(type).toLowerCase();
}

/** The plain title Keel gives a control, when it has one (also used by the Value report). */
export function plainControlTitle(controlId: string): string | null {
  return CONTROL_WORDS[controlId]?.title ?? null;
}

export function controlName(finding: ComplianceFinding): string {
  return CONTROL_WORDS[finding.controlId]?.title ?? finding.title ?? "A control Keel no longer holds";
}

export function controlShort(finding: ComplianceFinding): string {
  return CONTROL_WORDS[finding.controlId]?.short ?? controlName(finding);
}

/** The kinds of setting a control reads: from its own words, else from its evidence. */
export function controlTypes(finding: ComplianceFinding): string[] {
  const own = CONTROL_WORDS[finding.controlId]?.types;
  if (own?.length) return own;
  return [...new Set(finding.evidence.map((entry) => entry.resourceType))];
}

/** "admin role assignments" */
export function findingTypes(finding: ComplianceFinding): string {
  const types = controlTypes(finding);
  return types.length ? types.map(kindWords).join(", ") : "nothing Keel backs up yet";
}

export function controlWhat(finding: ComplianceFinding): string {
  return CONTROL_WORDS[finding.controlId]?.what ?? `Checks ${findingTypes(finding)}.`;
}

export function controlWhy(finding: ComplianceFinding): string | null {
  return CONTROL_WORDS[finding.controlId]?.why ?? null;
}

export function controlService(finding: ComplianceFinding): CloudService {
  return typeService(controlTypes(finding)[0] ?? "other");
}

export function standardName(finding: ComplianceFinding): string {
  return finding.framework === "keel-custom" ? "Keel checks" : finding.framework.replace(/[-_]/g, " ").toUpperCase();
}

export type ControlResult = "failing" | "excepted" | "unknown" | "passing" | "not-relevant";

export const RESULTS: Record<ControlResult, { label: string; plural: string; tone: RiskTone | null; badge: "urgent" | "soon" | "fine" | "neutral"; icon: IconName; rank: number }> = {
  failing: { label: "Failing", plural: "Failing", tone: "urgent", badge: "urgent", icon: "x-circle", rank: 0 },
  excepted: { label: "With exception", plural: "With an exception", tone: "soon", badge: "soon", icon: "pause", rank: 1 },
  unknown: { label: "Could not check", plural: "Could not be checked", tone: "soon", badge: "soon", icon: "info", rank: 2 },
  passing: { label: "Passing", plural: "Passing", tone: "fine", badge: "fine", icon: "check-circle", rank: 3 },
  "not-relevant": { label: "Not relevant here", plural: "Not relevant here", tone: null, badge: "neutral", icon: "hide", rank: 4 },
};

export function isResult(value: string | null): value is ControlResult {
  return value !== null && value in RESULTS;
}

/** A fail hides only behind an exception in force; an ended or incomplete one leaves it failing. */
export function resultOf(finding: ComplianceFinding): ControlResult {
  if (finding.verdict === "fail") return finding.exposed ? "failing" : "excepted";
  if (finding.verdict === "unknown") return "unknown";
  if (finding.verdict === "pass") return "passing";
  return "not-relevant";
}

export function findingStatus(finding: ComplianceFinding): string {
  return RESULTS[resultOf(finding)].label;
}

export type ComplianceCounts = Record<ControlResult, number> & { total: number; ended: number };

export function complianceCounts(findings: ComplianceFinding[]): ComplianceCounts {
  const counts: ComplianceCounts = { failing: 0, excepted: 0, unknown: 0, passing: 0, "not-relevant": 0, total: findings.length, ended: 0 };
  for (const finding of findings) {
    counts[resultOf(finding)] += 1;
    if (finding.exposed && finding.exceptionState === "expired") counts.ended += 1;
  }
  return counts;
}

export function countsFromSummary(summary: ComplianceSummary): ComplianceCounts {
  return {
    failing: summary.exposed, excepted: summary.excepted, unknown: summary.unknown, passing: summary.passing,
    "not-relevant": summary.notApplicable, total: summary.controls, ended: summary.expiredExceptions,
  };
}

/** The header's status pill. */
export function complianceStatus(counts: ComplianceCounts): { tone: RiskTone; label: string } {
  if (counts.total === 0) return { tone: "low", label: "Not checked yet" };
  if (counts.failing) return { tone: "urgent", label: `${counts.failing} failing` };
  if (counts.unknown) return { tone: "soon", label: `${counts.unknown} could not be checked` };
  return { tone: "fine", label: "All pass" };
}

export interface ComplianceVerdict { text: string; detail?: string; tone: "urgent" | "soon" | "fine" | "neutral" }

export function complianceVerdict(data: ComplianceData): ComplianceVerdict {
  const counts = complianceCounts(data.findings);
  const now = data.generatedAt;
  if (counts.total === 0) return { text: "No control has been checked on this tenant yet.", detail: NOT_CHECKED_YET, tone: "neutral" };
  if (counts.failing === 1) {
    const finding = data.findings.find((entry) => entry.exposed)!;
    const text = finding.exceptionState === "expired"
      ? `1 control fails, and its exception ended ${ago(finding.exception?.expiresAt ?? null, now)}.`
      : finding.exceptionState === "incomplete"
        ? "1 control fails; its exception has no owner or end date, so it does not count."
        : "1 control fails, with no exception.";
    return { text, detail: `${controlName(finding)}: fix it in Microsoft 365, or accept it for a while with an exception.`, tone: "urgent" };
  }
  if (counts.failing > 1) {
    const ended = counts.ended ? `; ${counts.ended === 1 ? "one exception has" : `${counts.ended} exceptions have`} ended` : "";
    return { text: `${plural(counts.failing, "control fails", "controls fail")}${ended}.`, detail: "Open each one to see what it rests on, then fix it or accept it with an exception.", tone: "urgent" };
  }
  if (counts.unknown) {
    return { text: `No control fails; ${plural(counts.unknown, "control")} could not be checked.`, detail: "The backup each one needs is missing or too old.", tone: "soon" };
  }
  return { text: `All ${plural(counts.total, "checked control")} pass or have a current exception.`, tone: "fine" };
}

/** Why a control could not be checked, from the engine's reason code ("group:stale-observation"). */
export function reasonWords(finding: ComplianceFinding): string {
  const reason = finding.reason ?? "";
  const split = reason.indexOf(":");
  const type = split > 0 ? reason.slice(0, split) : controlTypes(finding)[0] ?? null;
  const code = split > 0 ? reason.slice(split + 1) : reason;
  const kind = type ? kindWords(type) : "settings";
  const one = kind.replace(/s$/, "");
  if (code === "no-observation") return `No backup of ${kind} has been made yet.`;
  if (code === "stale" || code === "stale-observation") return `The newest ${one} backup is too old for this check.`;
  if (code.startsWith("observation-")) return `The newest ${one} backup did not finish.`;
  if (code) return `The ${one} backup it needs cannot be used.`;
  return "Keel could not check it.";
}

/** The second line of a row and of a phone tile: the result in a few words. */
export function resultLine(finding: ComplianceFinding, now: string): string {
  switch (resultOf(finding)) {
    case "failing":
      if (finding.exceptionState === "expired") return `Exception ended ${ago(finding.exception?.expiresAt ?? null, now)}`;
      if (finding.exceptionState === "incomplete") return "Exception has no owner or end date";
      return "No exception";
    case "excepted":
      return `Accepted until ${formatDay(finding.exception?.expiresAt ?? null)}`;
    case "unknown":
      return reasonWords(finding).replace(/\.$/, "");
    case "passing":
      return "Met on the last check";
    default:
      return "Nothing to check on this tenant";
  }
}

export function formatDay(value: string | null): string {
  if (!value) return "an unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an unknown date" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Worst first: failing, then excepted, could not check, passing; then by name. */
export function orderFindings(findings: ComplianceFinding[]): ComplianceFinding[] {
  return [...findings].sort((left, right) => RESULTS[resultOf(left)].rank - RESULTS[resultOf(right)].rank || controlName(left).localeCompare(controlName(right)));
}

/* --------------------------------------------------------------- exceptions -- */

/** The owner as a person: by name when they are in Keel, else the name an address reads as. */
export function ownerPerson(finding: ComplianceFinding): EngineRef | null {
  const exception = finding.exception;
  if (!exception?.owner && !exception?.ownerRef) return null;
  if (exception.ownerRef) return { kind: "person", id: exception.ownerRef.id, name: exception.ownerRef.name, readable: true, email: exception.owner ?? undefined } as EngineRef;
  return { kind: "person", id: "", name: exception.owner ?? "", readable: true } as EngineRef;
}

export function ownerName(finding: ComplianceFinding): string {
  return personLabel(ownerPerson(finding), "no named owner");
}

export function grantedByName(finding: ComplianceFinding): string | null {
  const ref = finding.exception?.grantedByRef;
  return ref ? ref.name : null;
}

/** The exception chip: in force until a date, ended, or not counted. */
export function exceptionChip(finding: ComplianceFinding, now: string): { tone: "urgent" | "soon"; label: string } | null {
  switch (finding.exceptionState) {
    case "authorized": return { tone: "soon", label: `Until ${formatDay(finding.exception?.expiresAt ?? null)}` };
    case "expired": return { tone: "urgent", label: `Ended ${ago(finding.exception?.expiresAt ?? null, now)}` };
    case "incomplete": return { tone: "urgent", label: "Not counted: no owner or end date" };
    default: return null;
  }
}

export function exceptionSentence(finding: ComplianceFinding, now: string): string | null {
  const exception = finding.exception;
  if (!exception) return null;
  const owner = ownerName(finding);
  switch (finding.exceptionState) {
    case "authorized":
      return `Exception owned by ${owner} until ${formatDay(exception.expiresAt)}.`;
    case "expired":
      return `The exception owned by ${owner} ended ${ago(exception.expiresAt, now)}, so this control counts as failing again.`;
    case "incomplete":
      return "An exception was recorded without an owner or an end date, so it does not count.";
    default:
      return null;
  }
}

/** Who may grant: someone with the configuration permission, on a control that fails. */
export function canGrantOn(finding: ComplianceFinding, canConfigure: boolean): boolean {
  return canConfigure && finding.verdict === "fail";
}

/** "Grant an exception", or "Renew the exception" when one ended or was incomplete. */
export function grantLabel(finding: ComplianceFinding): string {
  if (finding.exceptionState === "authorized") return "Extend the exception";
  return finding.exception ? "Renew the exception" : "Grant an exception";
}

export const EXCEPTION_EFFECT = "The control still fails; it stops counting as failing until the date you pick. The check itself does not change.";

export function exceptionRefusal(status: number, error: string | undefined): string {
  if (status === 403) return "You need the configuration permission to grant an exception.";
  if (status === 404) return "Keel no longer holds this result. Reload the page.";
  if (error === "owner_required") return "Name who owns the exception.";
  if (error === "reason_required") return "Say why the control may fail for now.";
  if (error === "expiry_in_future") return "Pick an end date after today.";
  if (error === "not_failing") return "Only a failing control can have an exception.";
  if (status === 0) return "Keel could not be reached. Check your connection and try again.";
  return "Keel could not save the exception. Try again.";
}

/* ------------------------------------------------------------------ links -- */

export function evidenceSentence(finding: ComplianceFinding, now: string): string {
  const { backup } = finding.links;
  if (backup.state === "none") return "This check rests on no stored backup.";
  if (backup.state === "mismatch") {
    return "No stored backup matches the collection this check used, so it is not linked to one.";
  }
  return `Checked against the backup collected ${ago(newestBackup(finding), now)}.`;
}

export function newestBackup(finding: ComplianceFinding): string | null {
  return finding.links.backup.linked
    .map((entry) => entry.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

export function evidenceSnapshot(finding: ComplianceFinding): string | null {
  const newest = newestBackup(finding);
  return finding.links.backup.linked.find((entry) => entry.completedAt === newest)?.snapshotId ?? null;
}

/** A linked change by name: "Global Administrator · adele@… added" reads as a name and a verb. */
export function linkedChangeName(change: ComplianceFinding["links"]["change"]["linked"][number]): string {
  const name = changeName({ naturalKey: change.naturalKey, resourceType: change.resourceType, name: null });
  const verb = change.changeType === "added" ? "added" : change.changeType === "removed" ? "removed" : "changed";
  // An address inside the key reads as the name in it ("adele@…" reads "Adele").
  const plain = name.replace(/[^\s@·]+@[^\s@·]+/g, (email) => personLabel({ kind: "person", id: "", name: email, readable: true }, "someone"));
  return `${plain} ${verb}`;
}

export function changeLinkSentence(finding: ComplianceFinding): string | null {
  const { change } = finding.links;
  if (change.state === "none") return null;
  const linked = change.linked.length
    ? `${plural(change.linked.length, "open change")} in the same backup.`
    : null;
  const mismatched = change.mismatched.length
    ? `${plural(change.mismatched.length, "open change")} to these kinds ${change.mismatched.length === 1 ? "comes" : "come"} from a different backup, so ${change.mismatched.length === 1 ? "it is" : "they are"} not linked.`
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

/* ----------------------------------------------------------------- storage -- */

const PROVIDER_WORDS: Record<string, string> = {
  "local-disk": "this server's disk",
  "s3-compatible": "S3-compatible object storage",
};

const REGION_WORDS: Record<string, string> = {
  westeurope: "West Europe",
  northeurope: "North Europe",
  uksouth: "UK South",
  ukwest: "UK West",
  francecentral: "France Central",
  germanywestcentral: "Germany West Central",
  eastus: "East US",
  eastus2: "East US 2",
  westus: "West US",
  "eu-west-1": "Ireland",
  "eu-central-1": "Frankfurt",
  "us-east-1": "North Virginia",
};

export function regionWords(region: string | null): string | null {
  if (!region) return null;
  return REGION_WORDS[region.toLowerCase()] ?? region.replace(/[-_]/g, " ");
}

export function storageSentence(storage: StorageResidency): string {
  if (!storage.configured || !storage.provider) {
    return "Where backups are stored is not set, so Keel cannot say where they are kept.";
  }
  const where = PROVIDER_WORDS[storage.provider] ?? storage.provider.replaceAll("-", " ");
  const region = regionWords(storage.region);
  return `Backups are kept on ${where}${region ? ` (${region})` : ""}.`;
}

export function immutabilitySentence(storage: StorageResidency): string {
  switch (storage.immutability) {
    case "unsupported":
      return "They cannot be locked against deletion.";
    case "live-qualified":
      return "Locking them against deletion is proven on this tenant.";
    default:
      return "Locking them against deletion is not yet proven on this tenant.";
  }
}

export const NOT_A_CERTIFICATION =
  "This states where backups are kept. It is not a certification of compliance with any regulation.";

/** How the checks run, said where results are shown. */
export const NOT_RUN_YET = "Keel checks these after each backup. Results come from the last check.";

/** The empty state's next step. */
export const NOT_CHECKED_YET = "Keel checks these after each backup. Results show here after the next backup or check.";

/** When the newest result was recorded, or null when nothing was checked. */
export function lastChecked(findings: ComplianceFinding[], now: string): string | null {
  const times = findings.map((finding) => Date.parse(finding.evaluatedAt ?? "")).filter(Number.isFinite);
  return times.length ? `Last checked ${ago(new Date(Math.max(...times)).toISOString(), now)}.` : null;
}

/** What to do when Keel cannot say where backups are kept. */
export const STORAGE_UNSET_TODO = "Ask whoever runs the Keel server to record where backups are stored. Until then, this page and Resilience cannot say where they are.";
