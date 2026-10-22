// The Baselines section in plain words (handoff/redesign/CHOICE.md, "Baselines"): the
// approved setup per service, the open changes against it, and what each decision does.
// Pure helpers, shared by the pages, the UI harness and the tests. "Approved setup" is
// the reader's word for a baseline (redesign rule 3); ids stay in the record layer.
import { typeInfo } from "../../engine/insights/taxonomy.mjs";
import { WORKLOAD_LABELS } from "@/lib/compare-view";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { RESOURCE_TYPE_LABELS, ago, displayEnum } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { madeInSharePoint, serviceFor, serviceOrder, type CloudService } from "@/lib/services";
import type { BaselineRecord, DriftRecord } from "@/lib/types";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

export const setupName = (baseline: Pick<BaselineRecord, "label">): string => baseline.label ?? "Unnamed approved setup";

/** Risk colour for a change's impact: lock-out is urgent, access is check soon, the rest low. */
export function impactTone(blastRadius: string): RiskTone {
  if (blastRadius === "tenant-lockout") return "urgent";
  if (blastRadius === "access-affecting") return "soon";
  return "low";
}

export const impactWords = (blastRadius: string): string => displayEnum("blastRadius", blastRadius);

/** The Microsoft service a stored type belongs to (engine taxonomy), never the code alone. */
export function typeService(type: string): CloudService {
  return serviceFor(typeInfo(type).service);
}

/** The service one setting sits under: its type's, except the sign-in rules SharePoint
 * admin center made, which are SharePoint settings. */
export function itemService(item: { resourceType: string; name?: string | null }): CloudService {
  return madeInSharePoint(item.resourceType, item.name) ? serviceFor("SharePoint") : typeService(item.resourceType);
}

/** Why a kind of setting matters, from the taxonomy's priority reason. */
export function whyItMatters(type: string): string {
  const info = typeInfo(type);
  return info.known && info.priorityReason ? info.priorityReason : "Keel has not ranked this kind of setting yet.";
}

// The redesign's plain names for the Microsoft terms people trip over (AUDIT.md rule 3).
// The Microsoft term stays in Technical details.
const PLAIN_KINDS: Record<string, string> = {
  conditionalAccessPolicy: "Sign-in rule",
  namedLocation: "Trusted location",
};

/** "Sign-in rule" for a Conditional Access policy; the taxonomy name for a service read
 * ("Exchange mail flow or protection rule"); the catalogue name for everything else. */
export function plainKind(type: string): string {
  if (PLAIN_KINDS[type]) return PLAIN_KINDS[type];
  if (Object.hasOwn(WORKLOAD_LABELS, type)) return typeInfo(type).name;
  // A type with no portal label reads as its taxonomy name, never as its code in words.
  return Object.hasOwn(RESOURCE_TYPE_LABELS, type) || !typeInfo(type).known ? typeName(type) : typeInfo(type).name;
}

/** "Block legacy auth (sign-in rule)" */
export function plainLabel(naturalKey: string): string {
  const [type, ...rest] = naturalKey.split(":");
  return `${rest.join(" · ") || naturalKey} (${plainKind(type).toLowerCase()})`;
}

export function changeWord(changeType: DriftRecord["changeType"]): string {
  return changeType === "added" ? "Added" : changeType === "removed" ? "Removed" : "Changed";
}

/** "Sign-in rule · changed": what the thing is, then what happened to it. */
export function kindLine(item: Pick<DriftRecord, "resourceType" | "changeType">): string {
  return `${plainKind(item.resourceType)} · ${changeWord(item.changeType).toLowerCase()}`;
}

/** Who made a change, from the audit log, or null when Keel does not know. */
export function changedBy(item: Pick<DriftRecord, "attribution">): string | null {
  const actors = item.attribution?.actors ?? [];
  const named = actors.map((actor) => actor.name).filter((name): name is string => Boolean(name));
  if (!named.length) return null;
  return named.length === 1 ? named[0] : `${named[0]} and ${named.length - 1} more`;
}

export interface ServiceSummary {
  service: CloudService;
  // What the service is measured against. Entra ID and Intune settings sit in the
  // approved setup. Exchange, SharePoint and OneDrive, Teams, Purview and Power Platform
  // settings are service reads: an approved setup cannot hold them yet, so each read is
  // compared with the one before it (engine/govern/workloadDrift.mjs).
  basis: "approved-setup" | "previous-backup";
  // Kinds of setting the approved setup holds that match it today; for a service read,
  // the kinds read in the latest backup with no change since the one before.
  inLine: string[];
  // Open changes (settings) in this service, and the kinds they touch.
  changed: number;
  changedKinds: string[];
  // Kinds Keel backs up that the approved setup does not hold yet; for a service read,
  // the kinds whose latest read failed or has not run.
  notCovered: string[];
  tone: RiskTone;
}

/** A service read Keel lists on What's protected: the workload code, and whether its
 * latest read succeeded. */
export interface ServiceReadKind {
  type: string;
  read: boolean;
}

/** One line per service: in line, changed, not covered. Services that need action come
 * first, then Microsoft's own order. Service reads (`serviceReads`, and changes that
 * carry `serviceRead`) join the Entra ID and Intune kinds, so every service shows. */
export function serviceSummaries(
  baseline: Pick<BaselineRecord, "capture"> | null,
  items: (Pick<DriftRecord, "resourceType" | "blastRadius"> & Partial<Pick<DriftRecord, "serviceRead" | "name">>)[],
  backedUp: string[],
  serviceReads: ServiceReadKind[] = [],
): ServiceSummary[] {
  const reads = new Set([
    ...serviceReads.map((read) => read.type),
    ...items.filter((item) => item.serviceRead).map((item) => item.resourceType),
  ]);
  const captured = new Set(baseline?.capture?.types ?? []);
  const changedTypes = new Set(items.map((item) => item.resourceType));
  const byCode = new Map<string, ServiceSummary>();
  const entry = (type: string, service: CloudService = typeService(type)) => {
    let summary = byCode.get(service.code);
    if (!summary) {
      summary = { service, basis: "previous-backup", inLine: [], changed: 0, changedKinds: [], notCovered: [], tone: "fine" };
      byCode.set(service.code, summary);
    }
    // One kind held in the approved setup makes the service measured against it.
    if (!reads.has(type)) summary.basis = "approved-setup";
    return summary;
  };
  for (const type of captured) if (!changedTypes.has(type)) entry(type).inLine.push(type);
  for (const item of items) {
    const summary = entry(item.resourceType, itemService(item));
    summary.changed += 1;
    if (!summary.changedKinds.includes(item.resourceType)) summary.changedKinds.push(item.resourceType);
    summary.tone = worstTone([summary.tone, impactTone(item.blastRadius)]) ?? summary.tone;
  }
  for (const type of new Set(backedUp)) {
    if (!reads.has(type) && !captured.has(type) && !changedTypes.has(type)) entry(type).notCovered.push(type);
  }
  for (const read of serviceReads) {
    if (changedTypes.has(read.type)) continue;
    const summary = entry(read.type);
    const bucket = read.read ? summary.inLine : summary.notCovered;
    if (!bucket.includes(read.type)) bucket.push(read.type);
  }
  const rank: Record<RiskTone, number> = { urgent: 0, soon: 1, low: 2, fine: 3 };
  return [...byCode.values()]
    .map((summary) => ({ ...summary, inLine: summary.inLine.sort(), notCovered: summary.notCovered.sort() }))
    .sort((a, b) => rank[a.tone] - rank[b.tone] || serviceOrder(a.service.code) - serviceOrder(b.service.code));
}

/** The status pill: what the approved setup needs right now. */
export function setupStatus(active: BaselineRecord | null, items: Pick<DriftRecord, "blastRadius">[]): { tone: RiskTone; label: string } {
  if (!active) return { tone: "urgent", label: "None approved" };
  if (!items.length) return { tone: "fine", label: "In line" };
  const tone = worstTone(items.map((item) => impactTone(item.blastRadius))) ?? "low";
  return { tone, label: `${plural(items.length, "change")} to review` };
}

/** The page verdict, one sentence: how the tenant stands against the approved setup. */
export function setupVerdict(active: BaselineRecord | null, items: Pick<DriftRecord, "blastRadius">[] | null, now: string): { text: string; tone: "good" | "attention" | "critical" } {
  if (!active) return { text: "No setup is approved yet, so Keel cannot tell what changed. Create one from a backup.", tone: "critical" };
  const name = `“${setupName(active)}”`;
  const when = active.capture?.capturedAt ? `, captured ${ago(active.capture.capturedAt, now)}` : "";
  if (items === null) return { text: `The tenant is measured against ${name}${when}.`, tone: "good" };
  if (!items.length) return { text: `The tenant matches ${name}${when}.`, tone: "good" };
  const lockout = items.filter((item) => item.blastRadius === "tenant-lockout").length;
  const head = `${plural(items.length, "change")} since ${name}${when}`;
  if (lockout) return { text: `${head}; ${lockout} could lock out admins.`, tone: "critical" };
  return { text: `${head}; none could lock anyone out.`, tone: "attention" };
}

/** A version's state in words. */
export function versionState(baseline: BaselineRecord): { label: string; tone: RiskTone | null } {
  if (baseline.supersededById || baseline.supersededAt) return { label: "Replaced by a newer version", tone: null };
  return baseline.active ? { label: "In use", tone: "fine" } : { label: "Not in use", tone: null };
}

/** "4,812 settings in 6 kinds" */
export function coverageWords(baseline: BaselineRecord): string {
  const kinds = baseline.capture?.types.length ?? 0;
  return `${plural(baseline.resourceCount, "setting")}${kinds ? ` in ${plural(kinds, "kind")}` : ""}`;
}

export function kindsWords(types: string[], limit = 3): string {
  if (!types.length) return "";
  const names = types.map(plainKind);
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

export type Decision = "accept" | "ignore" | "undo";

/** What a decision does, before it does it. */
export function decisionWords(decision: Decision, count: number): { title: string; detail: string; confirm: string } {
  const changes = plural(count, "change");
  if (decision === "accept") {
    return {
      title: `Accept ${changes} into the approved setup`,
      detail: `Keel records ${count === 1 ? "it" : "them"} as approved and stops flagging ${count === 1 ? "it" : "them"}. Nothing in Microsoft 365 changes.`,
      confirm: `Accept ${changes}`,
    };
  }
  if (decision === "ignore") {
    return {
      title: `Ignore ${changes} for now`,
      detail: `Keel hides ${count === 1 ? "it" : "them"} until the date you pick, then flags ${count === 1 ? "it" : "them"} again. Nothing in Microsoft 365 changes.`,
      confirm: `Ignore ${changes}`,
    };
  }
  return {
    title: `Undo ${changes}`,
    detail: `Keel puts the approved values back in Microsoft 365. First it shows what it would do, and nothing changes until someone else approves.`,
    confirm: "Send for approval",
  };
}

/** One-click comparisons for the Compare page: the approved setup against the newest
 * backup, and the last two backups. Only pairs whose backups can be chosen are offered. */
export function quickComparisons(
  own: { snapshots: { id: string; completedAt: string | null }[] } | undefined,
  active: Pick<BaselineRecord, "label" | "capture"> | null,
): { label: string; about: string; from: string; to: string }[] {
  const snapshots = own?.snapshots ?? [];
  const latest = snapshots[0];
  const picks: { label: string; about: string; from: string; to: string }[] = [];
  const source = active?.capture?.sourceSnapshotId;
  if (latest && source && source !== latest.id && snapshots.some((snapshot) => snapshot.id === source)) {
    picks.push({ label: "Approved setup and the latest backup", about: `What changed since “${setupName(active!)}” was captured`, from: source, to: latest.id });
  }
  if (snapshots.length >= 2) {
    picks.push({ label: "The last two backups", about: "What changed between the two newest backups", from: snapshots[1].id, to: latest.id });
  }
  const latestAt = latest?.completedAt ? Date.parse(latest.completedAt) : NaN;
  const weekAgo = Number.isNaN(latestAt) ? undefined : snapshots.find((snapshot) => snapshot.completedAt && Date.parse(snapshot.completedAt) <= latestAt - 6 * 86_400_000);
  if (weekAgo && weekAgo.id !== snapshots[1]?.id && weekAgo.id !== source) {
    picks.push({ label: "A week ago and the latest backup", about: "What changed over the last week", from: weekAgo.id, to: latest.id });
  }
  return picks;
}
