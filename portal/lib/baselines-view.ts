// The Baselines section in plain words (handoff/redesign/CHOICE.md, "Baselines"): the
// approved setup per service, the open changes against it, and what each decision does.
// Pure helpers, shared by the pages, the UI harness and the tests. "Approved setup" is
// the reader's word for a baseline (redesign rule 3); ids stay in the record layer.
import { approvalWords, type ApprovalModeName } from "@/lib/approval-words";
import { objectTypeName, typeInfo } from "../../engine/insights/taxonomy.mjs";
import { WORKLOAD_LABELS } from "@/lib/compare-view";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { RESOURCE_TYPE_LABELS, ago, displayEnum } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { madeInSharePoint, serviceFor, serviceOrder, type CloudService } from "@/lib/services";
import type { ComplianceScore } from "@/lib/compliance-view";
import { itemArea, itemKind } from "@/lib/type-groups";
import type { BackupGap, BaselineRecord, DriftRecord } from "@/lib/types";

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

/** The service one setting sits under: its kind's, except the sign-in rules SharePoint
 * admin center made, which are SharePoint settings. Endpoint security policies made in
 * Intune (antivirus, firewall…) are Defender settings. */
export function itemService(item: { resourceType: string; name?: string | null; templateFamily?: string | null }): CloudService {
  return madeInSharePoint(item.resourceType, item.name) ? serviceFor("SharePoint") : typeService(itemKind(item));
}

/** Why a kind of setting matters, from the taxonomy's priority reason. */
export function whyItMatters(type: string): string {
  const info = typeInfo(type);
  return info.known && info.priorityReason ? info.priorityReason : "Keel has not ranked this setting type yet.";
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

/** What one setting is: "Antivirus policy" for an endpoint security policy, "Built-in
 * admin role" or "Custom admin role" for an Entra role by its isBuiltIn flag, else the
 * plain name of its kind. */
export function itemKindName(item: { resourceType: string; templateFamily?: string | null; builtIn?: boolean | null }): string {
  const area = itemArea(item);
  if (area) return `${area} policy`;
  const kind = itemKind(item);
  const named = objectTypeName(kind, item.builtIn ?? null);
  return named !== typeInfo(kind).name ? named : plainKind(kind);
}

/** "Sign-in rule · changed": what the thing is, then what happened to it. */
export function kindLine(item: Pick<DriftRecord, "resourceType" | "changeType"> & Partial<Pick<DriftRecord, "templateFamily" | "builtIn">>): string {
  return `${itemKindName(item)} · ${changeWord(item.changeType).toLowerCase()}`;
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
  // Of those, kinds the approved setup holds whose latest read failed or has not run.
  notRead?: string[];
  tone: RiskTone;
  // Settings that match the approved setup out of every setting judged (matchScore);
  // null when the setting counts are not known.
  score: ComplianceScore | null;
}

/** A service read Keel lists on What's protected: the workload code, and whether its
 * latest read succeeded. */
export interface ServiceReadKind {
  type: string;
  read: boolean;
  // Settings the latest read found, and its open changes by kind, counted in full (not
  // the page's list of recent ones); absent or null when not known, and then the read
  // gets no score.
  itemCount?: number | null;
  open?: ChangeTally | null;
}

/** Settings judged and settings that match, before they become a percentage. */
export interface MatchCount {
  matching: number;
  judged: number;
}

/** Matching ÷ judged as a score, rounded down so it never reads 100% with a change left
 * (the same rule as the Compliance score). */
export function matchScore({ matching, judged }: MatchCount): ComplianceScore {
  return { passed: matching, evaluated: judged, excepted: 0, percent: judged ? Math.floor((matching / judged) * 100) : null };
}

/** The open changes to one kind of setting, by what they did. */
export type ChangeTally = Record<DriftRecord["changeType"], number>;

/**
 * How many settings of one kind match the approved setup.
 * - A kind the approved setup holds: it holds `held` settings. Each one changed or
 *   removed since no longer matches, and each one added is a setting it does not hold.
 * - A service read: the latest read found `held` settings. Each one added or changed since
 *   the read before does not match, and each one removed is a setting that is missing.
 */
export function kindMatch(held: number, changes: ChangeTally, basis: ServiceSummary["basis"]): MatchCount {
  if (basis === "approved-setup") {
    return { judged: held + changes.added, matching: Math.max(0, held - changes.modified - changes.removed) };
  }
  return { judged: held + changes.removed, matching: Math.max(0, held - changes.added - changes.modified) };
}

/** Every service's match counts added up: the overall score. */
export function overallScore(summaries: Pick<ServiceSummary, "score">[]): ComplianceScore | null {
  const scored = summaries.filter((summary) => summary.score);
  if (!scored.length) return null;
  return matchScore({
    matching: scored.reduce((sum, summary) => sum + summary.score!.passed, 0),
    judged: scored.reduce((sum, summary) => sum + summary.score!.evaluated, 0),
  });
}

/** One line per service: in line, changed, not covered. Services that need action come
 * first, then Microsoft's own order. Service reads (`serviceReads`, and changes that
 * carry `serviceRead`) join the Entra ID and Intune kinds, so every service shows. A
 * service read the approved setup holds (`capture.services`) is measured against it
 * like a Graph kind; one it does not hold yet keeps its own setup from Keel's first read. */
export function serviceSummaries(
  baseline: Pick<BaselineRecord, "capture"> | null,
  items: (Pick<DriftRecord, "resourceType" | "blastRadius"> & Partial<Pick<DriftRecord, "serviceRead" | "name" | "changeType" | "templateFamily">>)[],
  backedUp: string[],
  serviceReads: ServiceReadKind[] = [],
  // Settings the approved setup holds, per kind (portal-data getBaselineTypeCounts). Without
  // it no service gets a score.
  held: Record<string, number> | null = null,
): ServiceSummary[] {
  // Service settings the approved setup holds, per service read, from its capture.
  const heldServices = new Map((baseline?.capture?.services ?? []).map((service) => [service.workload, service.settings]));
  const reads = new Set([
    ...serviceReads.map((read) => read.type),
    ...items.filter((item) => item.serviceRead).map((item) => item.resourceType),
  ].filter((type) => !heldServices.has(type)));
  const captured = new Set(baseline?.capture?.types ?? []);
  // A change to an endpoint security policy is a Defender change: it leaves the Intune
  // settings catalog policies in line when no plain one changed.
  const changedTypes = new Set(items.filter((item) => itemKind(item) === item.resourceType).map((item) => item.resourceType));
  const byCode = new Map<string, ServiceSummary>();
  const entry = (type: string, service: CloudService = typeService(type)) => {
    let summary = byCode.get(service.code);
    if (!summary) {
      summary = { service, basis: "previous-backup", inLine: [], changed: 0, changedKinds: [], notCovered: [], tone: "fine", score: null };
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
    const kind = itemKind(item);
    if (!summary.changedKinds.includes(kind)) summary.changedKinds.push(kind);
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
    if (!read.read && heldServices.has(read.type)) summary.notRead = [...(summary.notRead ?? []), read.type];
  }
  if (held) {
    // Each kind is scored on its own, then added up under its service. Kinds not covered
    // or not read are left out: nothing is known about them.
    const tallies = new Map<string, ChangeTally>();
    for (const item of items) {
      const tally = tallies.get(item.resourceType) ?? { added: 0, modified: 0, removed: 0 };
      tally[item.changeType ?? "modified"] += 1;
      tallies.set(item.resourceType, tally);
    }
    const readCounts = new Map(serviceReads.map((read) => [read.type, read.read && read.open ? read.itemCount ?? null : null]));
    const readOpen = new Map(serviceReads.map((read) => [read.type, read.open ?? null]));
    const scored = new Set([...captured, ...changedTypes, ...serviceReads.filter((read) => read.read).map((read) => read.type)]);
    const counts = new Map<string, MatchCount>();
    for (const type of scored) {
      const basis = reads.has(type) ? "previous-backup" : "approved-setup";
      const count = basis === "approved-setup" ? heldServices.get(type) ?? held[type] ?? 0 : readCounts.get(type);
      // A service read whose size is not known cannot be scored.
      if (count === null || count === undefined) continue;
      // A service read counts its open changes in full; the list of changes may hold only recent ones.
      const changes = (basis === "previous-backup" || heldServices.has(type) ? readOpen.get(type) : null) ?? tallies.get(type) ?? { added: 0, modified: 0, removed: 0 };
      const match = kindMatch(count, changes, basis);
      if (!match.judged) continue;
      const code = entry(type).service.code;
      const sum = counts.get(code) ?? { matching: 0, judged: 0 };
      counts.set(code, { matching: sum.matching + match.matching, judged: sum.judged + match.judged });
    }
    for (const [code, count] of counts) byCode.get(code)!.score = matchScore(count);
  }
  const rank: Record<RiskTone, number> = { urgent: 0, soon: 1, low: 2, fine: 3 };
  return [...byCode.values()]
    .map((summary) => ({ ...summary, inLine: summary.inLine.sort(), notCovered: summary.notCovered.sort() }))
    .sort((a, b) => rank[a.tone] - rank[b.tone] || serviceOrder(a.service.code) - serviceOrder(b.service.code));
}

/** The status pill: what the approved setup needs right now. */
/** The page header badge. `total` is the open-changes count (changes-view openChangeCount)
 * when the page lists fewer changes than are open; the tone comes from those listed. */
export function setupStatus(active: BaselineRecord | null, items: Pick<DriftRecord, "blastRadius">[], total = items.length): { tone: RiskTone; label: string } {
  if (!active) return { tone: "urgent", label: "None approved" };
  const count = Math.max(total, items.length);
  if (!count) return { tone: "fine", label: "In line" };
  const tone = worstTone(items.map((item) => impactTone(item.blastRadius))) ?? "low";
  return { tone, label: `${plural(count, "change")} to review` };
}

/** The page verdict, one sentence: how the tenant stands against the approved setup. */
export function setupVerdict(active: BaselineRecord | null, items: Pick<DriftRecord, "blastRadius">[] | null, now: string, total = items?.length ?? 0): { text: string; tone: "good" | "attention" | "critical" } {
  if (!active) return { text: "No setup is approved yet, so Keel cannot tell what changed. Create one from a backup.", tone: "critical" };
  const name = `“${setupName(active)}”`;
  // When it was approved, as on the Overview and the Changes page. Its settings can be
  // older (a version put back from an earlier one); the page says that beside it.
  const when = active.setAt ? `, approved ${ago(active.setAt, now)}` : "";
  if (items === null) return { text: `The tenant is measured against ${name}${when}.`, tone: "good" };
  const count = Math.max(total, items.length);
  if (!count) return { text: `The tenant matches ${name}${when}.`, tone: "good" };
  const lockout = items.filter((item) => item.blastRadius === "tenant-lockout").length;
  const head = `${plural(count, "change")} since ${name}${when}`;
  if (lockout) return { text: `${head}; ${lockout} could lock out admins.`, tone: "critical" };
  return { text: `${head}; none could lock anyone out.`, tone: "attention" };
}

/** A version's state in words. */
export function versionState(baseline: BaselineRecord): { label: string; tone: RiskTone | null } {
  if (baseline.supersededById || baseline.supersededAt) return { label: "Replaced by a newer version", tone: null };
  return baseline.active ? { label: "In use", tone: "fine" } : { label: "Not in use", tone: null };
}

/** A version put back from an earlier one, in words: which version it copies, that its
 * settings are that version's (so older than the version it replaced), and how much less
 * it holds than that one. Null for a version that was not put back. */
export function putBackWords(baseline: BaselineRecord, baselines: BaselineRecord[], now: string): string | null {
  const from = baseline.reinstatedFrom;
  if (!from) return null;
  const captured = baseline.capture?.capturedAt ?? null;
  const kinds = baseline.capture?.types.length ?? 0;
  const head = `This version is a copy of version ${from.version}, put back ${ago(baseline.setAt, now)}. It holds the settings version ${from.version} held${captured ? `, as they were ${ago(captured, now)}` : ""}${kinds ? `: ${plural(kinds, "setting type")}` : ""}.`;
  const replaced = baselines.find((other) => other.id === baseline.supersedesId);
  const before = replaced?.capture?.types.length ?? 0;
  if (!replaced || before <= kinds) return head;
  return `${head} Version ${replaced.version ?? 1}, which it replaced, held ${plural(before, "type")}, so ${plural(before - kinds, "type is", "types are")} not checked until you capture a new version.`;
}

/** Kinds Keel backs up now that the setup does not hold, in a sentence; null when none. */
export function notHeldWords(baseline: BaselineRecord, backedUp: string[]): string | null {
  const held = new Set(baseline.capture?.types ?? []);
  const missing = [...new Set(backedUp)].filter((type) => !held.has(type));
  if (!missing.length || !held.size) return null;
  return `${plural(missing.length, "setting type")} Keel backs up now ${missing.length === 1 ? "is" : "are"} not in it (${kindsWords(missing)}). Capture a new version to add ${missing.length === 1 ? "it" : "them"}.`;
}

function listWords(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Why "Capture new version" is off, in words: what a complete backup needs and what the
 * newest backup missed. `hasSource` is true when a newer complete backup exists. */
export function captureBlockedWords({ capturedAt, gap, hasSource, now, sources }: {
  capturedAt: string | null;
  gap: BackupGap | null;
  hasSource: boolean;
  now: string;
  sources: { completedAt: string | null }[];
}): string {
  if (hasSource) return "Capture new version: takes the setup from the newest complete backup. This version is kept, and you can go back to it.";
  const need = "Capture new version needs a newer complete backup: one that read every setting type in full.";
  if (gap) {
    const kinds = (types: string[]) => (types.length > 3 ? plural(types.length, "type") : kindsWords(types));
    const verb = (types: string[], one: string, many: string) => (types.length === 1 ? one : many);
    const parts = [
      gap.failed.length ? `${kinds(gap.failed)} could not be read` : null,
      gap.partial.length ? `${kinds(gap.partial)} ${verb(gap.partial, "was", "were")} read only in part` : null,
      gap.notInBackup.length ? `${kinds(gap.notInBackup)} ${verb(gap.notInBackup, "was", "were")} not part of it` : null,
    ].filter((part): part is string => Boolean(part));
    return `${need} The newest backup, finished ${ago(gap.completedAt, now)}, was not complete: ${listWords(parts)}.`;
  }
  if (!sources.length) return `${need} No backup has finished yet.`;
  const newest = sources[0]?.completedAt ?? null;
  return `${need} None has finished since this version's settings were taken${capturedAt ? ` ${ago(capturedAt, now)}` : ""}${newest ? `; the newest complete one finished ${ago(newest, now)}` : ""}.`;
}

/** "4,812 settings in 6 kinds", plus "and 320 service settings" when it holds any. */
export function coverageWords(baseline: BaselineRecord): string {
  const kinds = baseline.capture?.types.length ?? 0;
  const graph = `${plural(baseline.resourceCount, "setting")}${kinds ? ` in ${plural(kinds, "type")}` : ""}`;
  const services = baseline.capture?.services?.length ?? 0;
  return services && baseline.serviceSettingCount ? `${graph}, and ${plural(baseline.serviceSettingCount, "service setting")}` : graph;
}

/** What the setup holds of Exchange, SharePoint, Teams, Purview and Power Platform, in a
 * sentence, or null for a setup captured before it could hold them. */
export function serviceSettingsWords(baseline: BaselineRecord): string | null {
  const services = baseline.capture?.services ?? [];
  const missing = baseline.capture?.servicesNotRead ?? [];
  if (!services.length && !missing.length) return null;
  const head = services.length
    ? `Includes ${plural(services.length, "service read")} (${kindsWords(services.map((service) => service.workload))}).`
    : "Holds no service settings: no service read was available.";
  return missing.length ? `${head} Never read when captured: ${kindsWords(missing)}.` : head;
}

export function kindsWords(types: string[], limit = 3): string {
  if (!types.length) return "";
  const names = types.map(plainKind);
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

export type Decision = "accept" | "ignore" | "undo";

/** What a decision does, before it does it. */
export function decisionWords(decision: Decision, count: number, mode: ApprovalModeName = "two-person"): { title: string; detail: string; confirm: string } {
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
    detail: `Keel puts the approved values back in Microsoft 365. First it shows what it would do, and nothing changes until ${approvalWords(mode).approves}.`,
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
