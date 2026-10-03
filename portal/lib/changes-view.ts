// Roadmap task-131: changes (drift), roll-back previews and guard refusals in words.
// Pure helpers shared by the Changes and Restore pages and the UI harness. Natural
// keys, change-kind codes, planned verbs, waves, deferred references and refusal codes
// stay in the record layer.
import { ago, resourceLabel, words } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

/** "Block legacy auth" from "conditionalAccessPolicy:Block legacy auth". */
export function resourceName(naturalKey: string): string {
  const [, ...rest] = naturalKey.split(":");
  return rest.join(" · ") || naturalKey;
}

/** "Block legacy auth (Conditional Access policy) was changed". */
export function changeSentence(item: Pick<DriftRecord, "naturalKey" | "changeType">): string {
  const verb = item.changeType === "added" ? "was added" : item.changeType === "removed" ? "was removed" : "was changed";
  return `${resourceLabel(item.naturalKey)} ${verb}`;
}

/** "37 changes since the baseline set 2 days ago; 2 could lock out administrators." */
export function changesVerdict(items: DriftRecord[], baselineSetAt: string | null, now: string): { text: string; tone: "good" | "attention" | "critical" } {
  if (baselineSetAt === null) return { text: "No baseline is active, so KEEL cannot tell what changed.", tone: "critical" };
  const since = `since the baseline set ${ago(baselineSetAt, now)}`;
  if (items.length === 0) return { text: `Nothing has changed ${since}.`, tone: "good" };
  const lockout = items.filter((item) => item.blastRadius === "tenant-lockout").length;
  const count = `${items.length} ${items.length === 1 ? "change" : "changes"} ${since}`;
  if (lockout) return { text: `${count}; ${lockout} could lock out administrators.`, tone: "critical" };
  const access = items.filter((item) => item.blastRadius === "access-affecting").length;
  return access
    ? { text: `${count}; ${access} ${access === 1 ? "affects" : "affect"} access.`, tone: "attention" }
    : { text: `${count}; none affects access.`, tone: "attention" };
}

/** "conditions.users.excludeGroups" → "Conditions › users › exclude groups". */
export function fieldWords(path: string): string {
  if (path === "(value)") return "Value";
  return path.split(".").map((part, index) => {
    const spaced = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
    return index === 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
  }).join(" › ");
}

/** A field value as a person reads it; objects too large for a sentence point to the record. */
export function valueWords(value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString("en-GB");
  if (typeof value === "string") {
    if (value === "") return "empty";
    // Stored enum-like codes ("enabledForReportingButNotEnforced") read as words.
    return /^[a-z]+[A-Z][A-Za-z]*$/.test(value) ? words(value).toLowerCase() : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) return value.map(valueWords).join(", ");
    return `${value.length} ${value.length === 1 ? "entry" : "entries"} (see Technical details)`;
  }
  const keys = Object.keys(value as Record<string, unknown>).length;
  return `${keys} ${keys === 1 ? "setting" : "settings"} (see Technical details)`;
}

const VERB_WORDS: Record<string, string> = {
  update: "Put the baseline settings back",
  create: "Recreate it as the baseline has it",
  delete: "Remove it; the baseline does not have it",
};

/** What a roll-back would do to one resource, without the planned-verb code. */
export function plannedActionWords(verb: string): string {
  return VERB_WORDS[verb] ?? "Bring it back in line with the baseline";
}

// Reasons KEEL's safety checks give, keyed by the start of the stored reason.
const REFUSAL_REASONS: [RegExp, string][] = [
  [/^onPremisesSyncEnabled/i, "it is synced from on-premises Active Directory, which owns it"],
  [/report-only|enforce/i, "Conditional Access changes are only ever written in report-only mode"],
  [/lockout/i, "it could lock administrators out of the tenant"],
  [/required by|depends on|still references/i, "something else still depends on it"],
];

/** "KEEL refused to change Finance (group) because it is synced from on-premises Active Directory." */
export function refusalSentence(refusal: { naturalKey: string; reason: string }): string {
  const known = REFUSAL_REASONS.find(([pattern]) => pattern.test(refusal.reason))?.[1];
  // A reason that reads as plain words is quoted as is; a coded one stays in the record.
  const plain = !known && !/[=_:{}[\]]|\b[a-z]+[A-Z]/.test(refusal.reason) ? refusal.reason.replace(/\.$/, "") : null;
  const because = known ?? plain;
  return because
    ? `KEEL refused to change ${resourceLabel(refusal.naturalKey)} because ${because}.`
    : `KEEL refused to change ${resourceLabel(refusal.naturalKey)}; the reason is in Technical details.`;
}

export function changeKindWords(kind: "changed" | "added" | "removed"): string {
  return kind === "changed" ? "Changed" : kind === "added" ? "Added" : "Removed";
}

