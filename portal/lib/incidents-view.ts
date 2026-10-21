// Incidents page words (portal audit, pick B: incident picker at the top). Pure: the
// page header (a server component), the page body and the tests all read the same
// sentences from here. The engine decides which backup is cleared; nothing here
// re-ranks or re-qualifies a backup.
import type { IncidentDetail, IncidentExclusion, IncidentRecoveryPoint, IncidentServiceBackup, IncidentSummary } from "@/lib/portal-data";
import { namedSubject } from "@/lib/job-names";
import type { RiskTone } from "@/lib/menu-status";
import { RESOURCE_TYPE_LABELS, ago, formatTimestamp, words } from "@/lib/presentation";
import type { EngineRef } from "@/lib/sentences";
import type { Ref } from "@/lib/types";

export const DESCRIPTION = "During a security incident, restore from a backup an investigator has checked, not simply the newest one.";
export const KEPT_HELP = "Being kept does not mean it is clean.";
export const READ_ONLY_LINE = "Only investigators can change incidents.";
export const WINDOW_HELP = "Attack windows cannot be edited, because checks are tied to them. Add a new one if you learn more.";
export const CLOSE_EFFECT = "Closing stops new checks, keeps and permissions. Backups you kept stay kept until you let them go. The incident stays as a record.";
export const ALLOW_EFFECT = "Someone else must still ask for the restore, and approvers see your reason.";
export const HISTORY_HREF = "/activity?show=records&kind=incident-recovery";

export type BackupState = "cleared" | "unchecked" | "unsafe";
export type StateFilter = BackupState | "kept";
type BadgeTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export const STATES: Record<BackupState, { label: string; plural: string; tone: BadgeTone; risk: RiskTone | null; icon: "check-circle" | "clock" | "x-circle"; rank: number }> = {
  cleared: { label: "Cleared", plural: "Cleared", tone: "fine", risk: null, icon: "check-circle", rank: 0 },
  unchecked: { label: "Not checked", plural: "Not checked", tone: "soon", risk: "soon", icon: "clock", rank: 1 },
  unsafe: { label: "Unsafe", plural: "Unsafe", tone: "urgent", risk: "urgent", icon: "x-circle", rank: 2 },
};

export function isStateFilter(value: string | null | undefined): value is StateFilter {
  return value === "cleared" || value === "unchecked" || value === "unsafe" || value === "kept";
}

export function stateOf(point: Pick<IncidentRecoveryPoint, "status">): BackupState {
  return point.status === "qualified" ? "cleared" : point.status === "unsuitable" ? "unsafe" : "unchecked";
}

/** The chip on a row: "Needs a new check" when the attack window moved after the check. */
export function stateChip(point: Pick<IncidentRecoveryPoint, "status" | "stale">): string {
  return point.stale ? "Needs a new check" : STATES[stateOf(point)].label;
}

export function recoveryPointStatusLabel(status: IncidentRecoveryPoint["status"]): string {
  return STATES[stateOf({ status })].label;
}

/** "30 Sept 2026, 06:00 UTC": a backup is named by when it was taken. */
export function backupName(point: Pick<IncidentRecoveryPoint, "snapshot">): string {
  return point.snapshot.name.replace(/^Snapshot of /, "").replace(/^Snapshot at an unknown time$/, "A backup at an unknown time");
}

export function backupAge(point: Pick<IncidentRecoveryPoint, "observedTo" | "observedFrom">, now: string): string {
  const age = ago(point.observedTo ?? point.observedFrom, now);
  return `Backup · ${age.replace(/ ago$/, " old")}`;
}

export function restoreHref(snapshotId: string, incidentId: string): string {
  return `/restore?snapshot=${encodeURIComponent(snapshotId)}&incident=${encodeURIComponent(incidentId)}`;
}

/** A person as the shared Person piece draws them: a name, the email only on hover. */
export function personOf(ref: Ref | null | undefined): EngineRef | null {
  if (!ref) return null;
  const gone = /no longer readable/.test(ref.name) || ref.name === "Unknown owner" || ref.name === "Unknown";
  return { kind: "person", id: ref.id, name: ref.name, readable: !gone, email: ref.name.includes("@") ? ref.name : null };
}

/** "the “description” setting of Board (group)" or "Helpdesk Tier 0 (group)". */
export function exclusionLabel(exclusion: Pick<IncidentExclusion, "naturalKey" | "field"> & { displayName?: string | null }): string {
  const key = exclusion.naturalKey;
  const resource = namedSubject(key, exclusion.displayName ? { [key]: { name: exclusion.displayName, resourceType: "" } } : {});
  return exclusion.field ? `the “${words(exclusion.field).toLowerCase()}” setting of ${resource}` : resource;
}

export interface ParsedExclusion {
  naturalKey: string;
  field: string | null;
  reason: string;
}

/** One harmful item per line: `resource key | reason`, or `resource key#setting | reason`.
 * Kept for the command line and older links; the page uses the item picker. */
export function parseExclusions(text: string): { exclusions: ParsedExclusion[]; error: string | null } {
  const exclusions: ParsedExclusion[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const [target, ...reasonParts] = line.split("|");
    const reason = reasonParts.join("|").trim();
    const [naturalKey, field] = target.trim().split("#");
    if (!naturalKey || !reason) {
      return { exclusions: [], error: `Line ${index + 1}: write "resource key | reason" or "resource key#setting | reason".` };
    }
    exclusions.push({ naturalKey: naturalKey.trim(), field: field?.trim() || null, reason });
  }
  return { exclusions, error: null };
}

/** An item a backup holds, as the picker lists it: a name and a kind, never a key. */
export function itemLabel(item: { naturalKey: string; resourceType: string; name?: string | null }): { label: string; kind: string } {
  const kind = RESOURCE_TYPE_LABELS[item.resourceType] ?? words(item.resourceType).toLowerCase();
  const label = item.name?.trim() || namedSubject(item.naturalKey, {}, item.resourceType).replace(/ \([^)]*\)$/, "");
  return { label, kind };
}

export function harmfulItems(count: number): string {
  return count === 1 ? "1 harmful item" : `${count} harmful items`;
}

export function backupsWord(count: number): string {
  return `${count} ${count === 1 ? "backup" : "backups"}`;
}

// ------------------------------------------------------------------ page state

export interface IncidentCounts { open: number; closed: number; cleared: number; unchecked: number; unsafe: number; kept: number; uncheckedInWindow: number }

export function incidentCounts(incidents: IncidentSummary[], selected: IncidentDetail | null): IncidentCounts {
  const points = selected?.points ?? [];
  return {
    open: incidents.filter((incident) => incident.status === "open").length,
    closed: incidents.filter((incident) => incident.status === "closed").length,
    cleared: points.filter((point) => stateOf(point) === "cleared").length,
    unchecked: points.filter((point) => stateOf(point) === "unchecked").length,
    unsafe: points.filter((point) => stateOf(point) === "unsafe").length,
    kept: points.filter((point) => point.pinned).length,
    uncheckedInWindow: points.filter((point) => stateOf(point) === "unchecked" && point.inCompromiseWindow).length,
  };
}

/** The header's status pill. */
export function incidentStatus(incidents: IncidentSummary[], selected: IncidentDetail | null): { tone: RiskTone; label: string } {
  if (!selected || !incidents.some((incident) => incident.status === "open")) return { tone: "fine", label: "No open incident" };
  if (selected.incident.status === "closed") return { tone: "fine", label: "Incident closed" };
  return selected.recommended ? { tone: "soon", label: "Incident open, backup cleared" } : { tone: "urgent", label: "No backup cleared" };
}

export interface IncidentVerdict {
  tone: "fine" | "soon" | "urgent";
  text: string;
  detail?: string;
  action: { label: string; href: string } | null;
}

/** The page's one sentence (portal experience contract, verdict layer). */
export function incidentVerdict({ incidents, selected, now }: { incidents: IncidentSummary[]; selected: IncidentDetail | null; now?: string }): IncidentVerdict {
  if (incidents.length === 0 || !selected) {
    return { tone: "fine", text: "No security incidents are recorded. Restores can use any backup.", action: null };
  }
  const title = `“${selected.incident.title}”`;
  const recommended = selected.points.find((point) => point.snapshotId === selected.recommended) ?? null;
  if (selected.incident.status === "closed") {
    return {
      tone: "fine",
      text: `${title} was closed${selected.incident.closedAt && now ? ` ${ago(selected.incident.closedAt, now)}` : ""}. Its checks and kept backups stay as a record.`,
      action: null,
    };
  }
  if (!recommended) {
    return { tone: "urgent", text: `No backup is cleared for ${title} yet. An investigator must check one before you restore.`, action: null };
  }
  const left = recommended.assessment?.exclusions ?? [];
  return {
    tone: "soon",
    text: `Restore from the backup of ${backupName(recommended)}, the newest one cleared for ${title}.`,
    detail: left.length ? `It leaves out ${harmfulItems(left.length)}: ${left.map((exclusion) => exclusionLabel(exclusion)).join(", ")}.` : undefined,
    action: { label: "Restore from this backup", href: restoreHref(recommended.snapshotId, selected.incident.id) },
  };
}

/** Recommended first, then unsafe, then newest: what an investigator looks at first. */
export function orderBackups(points: IncidentRecoveryPoint[], recommended: string | null): IncidentRecoveryPoint[] {
  const time = (point: IncidentRecoveryPoint) => String(point.observedTo ?? point.observedFrom ?? "");
  return [...points].sort((a, b) =>
    Number(b.snapshotId === recommended) - Number(a.snapshotId === recommended)
    || Number(stateOf(b) === "unsafe") - Number(stateOf(a) === "unsafe")
    || time(b).localeCompare(time(a)));
}

/** The line under a row's chips: who checked it and when, or why nobody has. */
export function checkLine(point: IncidentRecoveryPoint, now: string): { prefix: string; person: EngineRef | null; when: string | null } {
  const assessment = point.assessment;
  if (assessment && stateOf(point) === "cleared") return { prefix: "Checked by", person: personOf(assessment.assessedBy), when: ago(assessment.assessedAt, now) };
  if (assessment && stateOf(point) === "unsafe") return { prefix: "Marked unsafe by", person: personOf(assessment.assessedBy), when: ago(assessment.assessedAt, now) };
  if (point.stale) return { prefix: "The attack window changed after it was checked", person: null, when: null };
  return { prefix: point.inCompromiseWindow ? "Nobody has checked it yet" : "Taken before the attack · nobody has checked it yet", person: null, when: null };
}

/** Why this backup is in the state it is, in one or two sentences. */
export function backupWhy(point: IncidentRecoveryPoint, detail: IncidentDetail, now: string): string {
  const recommended = detail.recommended === point.snapshotId;
  const parts: string[] = [];
  if (recommended) parts.push("The newest backup an investigator cleared.");
  else if (stateOf(point) === "cleared") parts.push("Cleared, but a newer backup is cleared too.");
  else if (stateOf(point) === "unsafe") parts.push("An investigator marked it unsafe, so a restore from it is refused.");
  else if (point.stale) parts.push("It needs a new check: the attack window changed after it was checked.");
  else parts.push("Not checked yet, so a restore from it needs an investigator's permission.");
  parts.push(point.inCompromiseWindow ? "Taken while the attacker had access." : beforeAttack(point, detail, now));
  return parts.filter(Boolean).join(" ");
}

function beforeAttack(point: IncidentRecoveryPoint, detail: IncidentDetail, _now: string): string {
  const starts = detail.intervals.map((interval) => interval.startsAt).filter((value): value is string => Boolean(value)).sort();
  const taken = point.observedTo ?? point.observedFrom;
  if (!starts.length || !taken) return detail.intervals.length ? "" : "No attack window is recorded yet.";
  const first = starts[0];
  const hours = Math.round((new Date(first).getTime() - new Date(taken).getTime()) / 3_600_000);
  if (hours <= 0) return "Taken after the attack window ended.";
  return `Taken ${hours < 48 ? `${hours} ${hours === 1 ? "hour" : "hours"}` : `${Math.round(hours / 24)} days`} before the attacker got in.`;
}

export function windowSentence(interval: IncidentDetail["intervals"][number]): string {
  const from = interval.startsAt ? formatTimestamp(interval.startsAt) : "an unknown time";
  return interval.endsAt ? `From ${from} until ${formatTimestamp(interval.endsAt)}` : `From ${from}, still ongoing`;
}

// ------------------------------------------------------------------ timeline

export interface TimelineDot { id: string; x: number; state: BackupState; recommended: boolean; label: string }
export interface TimelineBand { x: number; width: number; ongoing: boolean }
export interface Timeline { dots: TimelineDot[]; bands: TimelineBand[]; ticks: { x: number; label: string }[]; nowX: number }

/** Where each backup and attack window sits on one axis from the oldest backup to now
 * (0 to 1), so "taken during the attack" reads at a glance. */
export function timeline(detail: IncidentDetail, now: string): Timeline {
  const end = new Date(now).getTime();
  const times = [
    ...detail.points.map((point) => new Date(point.observedTo ?? point.observedFrom ?? now).getTime()),
    ...detail.intervals.map((interval) => new Date(interval.startsAt ?? now).getTime()),
  ].filter(Number.isFinite);
  const start = Math.min(end - 86_400_000, ...times);
  const span = Math.max(end - start, 1);
  const pad = span * 0.04;
  const from = start - pad;
  const total = end - from;
  const at = (value: number) => Math.min(1, Math.max(0, (value - from) / total));
  const bands = detail.intervals.map((interval) => {
    const a = at(new Date(interval.startsAt ?? now).getTime());
    const b = interval.endsAt ? at(new Date(interval.endsAt).getTime()) : 1;
    return { x: a, width: Math.max(b - a, 0.004), ongoing: !interval.endsAt };
  });
  const dots = detail.points.map((point) => ({
    id: point.snapshotId,
    x: at(new Date(point.observedTo ?? point.observedFrom ?? now).getTime()),
    state: stateOf(point),
    recommended: detail.recommended === point.snapshotId,
    label: `${backupName(point)}: ${stateChip(point)}`,
  }));
  const day = 86_400_000;
  const days = Math.ceil(total / day);
  const step = Math.max(1, Math.ceil(days / 6));
  const ticks: { x: number; label: string }[] = [];
  const first = new Date(from);
  first.setUTCHours(0, 0, 0, 0);
  for (let t = first.getTime() + day; t < end; t += step * day) {
    ticks.push({ x: at(t), label: new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) });
  }
  return { dots, bands, ticks, nowX: 1 };
}

// ------------------------------------------------------------------ errors

/** The engine's refusal, as a sentence for the person who asked. Never a key or an id. */
export function failureWords(status: number, message?: string | null): string {
  const text = message ?? "";
  if (status === 403) return "You can no longer change incidents. Ask an admin for the investigator role.";
  if (/compromised verdict refuses/.test(text)) return "An unsafe backup is refused as a whole. Leaving items out applies only to a clean one.";
  if (/field .* is not in this snapshot/.test(text)) return "That setting is not in this backup. Pick the item again, or leave the whole item out.";
  if (/is not in this snapshot/.test(text)) return "One of the items you left out is not in this backup. Pick it again from the list.";
  if (/duplicate exclusion/.test(text)) return "The same item is listed twice. Remove one.";
  if (/already qualified/.test(text)) return "This backup is already cleared, so it needs no permission.";
  if (/already pinned/.test(text)) return "This backup is already kept for this incident.";
  if (/incident is closed/.test(text)) return "This incident is closed, so it cannot change. Open a new incident instead.";
  if (/endsAt must be after startsAt/.test(text)) return "The end must be after the start.";
  if (/must be a timestamp/.test(text)) return "Pick a date and a time.";
  if (/(rationale|reason) is required/.test(text)) return "Write why.";
  if (/title is required/.test(text)) return "Give the incident a title.";
  if (status === 404) return "It was not found. Someone may have changed it; reload the page.";
  return "The change was not saved. Try again in a moment.";
}

/** One service backup against the attack window, in words. */
export function serviceBackupLine(entry: IncidentServiceBackup, now: string): string {
  const newest = entry.newestGood;
  if (!newest) return "No good backup yet.";
  const latest = `Newest good backup ${ago(newest.at, now)}${newest.inCompromiseWindow ? ", taken during the attack" : ""}.`;
  if (!newest.inCompromiseWindow) return latest;
  const before = entry.beforeWindow;
  return before ? `${latest} The newest from before the attack is ${ago(before.at, now)}.` : `${latest} None was taken before the attack started.`;
}
