import type { IconName } from "@/components/shell/icons";
import type { AlertItem } from "@/components/ui/alert-list";
import type { BadgeTone } from "@/components/ui/badge";
import type { StatTile } from "@/components/ui/stat-tiles";
import { namedSubject } from "@/lib/job-names";
import type { ActivationPreview, PreviewDrift } from "@/lib/policies";
import { askServerAdmin } from "@/lib/who-to-ask";

// The rule preview ("Before it turns on") as alerts, tiles and one table, worst first.
// Words only: every key, id and version stays in the preview's Technical details.

export type PreviewTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export type PreviewAlert = AlertItem & { title: string; todo: string; more: string[] };


export interface PreviewRow { key: string; name: string; what: string; impact: string; impactTone: BadgeTone; outcome: string; tone: PreviewTone; note: string | null }

export interface PreviewGroup { key: string; name: string; icon: IconName; rows: PreviewRow[] }

const IMPACT_WORDS: Record<string, string> = { cosmetic: "Low risk", "access-affecting": "Affects access", "tenant-lockout": "Could lock out admins" };
const IMPACT_TONES: Record<string, BadgeTone> = { cosmetic: "low", "access-affecting": "soon", "tenant-lockout": "urgent" };

export function impactWords(blastRadius: string | null): string {
  return (blastRadius && IMPACT_WORDS[blastRadius]) || "Not rated";
}

export function impactTone(blastRadius: string | null): BadgeTone {
  return (blastRadius && IMPACT_TONES[blastRadius]) || "neutral";
}

const CHANGE_WORDS: Record<string, string> = { modified: "Changed", added: "Added", removed: "Removed" };
const OPERATION_WORDS: Record<string, string> = {
  create: "Recreate", update: "Update", delete: "Delete", "restore-soft-deleted": "Restore from the recycle bin",
};
const UNKNOWN_WORDS: Record<string, string> = {
  "scope-unresolved": "Keel could not find the backup it would restore from",
  "not-in-backup": "It is not in the backup Keel would restore from",
  "unresolved-reference": "It refers to something that is not in the backup",
  "impact-unknown": "Its impact is not rated",
  "operation-unknown": "Keel does not recognise the type of change",
};
const FINDING_WORDS: Record<string, { label: string; tone: BadgeTone }> = {
  pass: { label: "Passing", tone: "fine" },
  fail: { label: "Failing", tone: "urgent" },
  unknown: { label: "Not known", tone: "neutral" },
  "not-applicable": { label: "Does not apply", tone: "neutral" },
  exception: { label: "Excepted", tone: "low" },
};

export function findingWords(verdict: string): { label: string; tone: BadgeTone } {
  return FINDING_WORDS[verdict] ?? { label: "Not known", tone: "neutral" };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function label(preview: ActivationPreview) {
  return (key: string) => namedSubject(key, preview.names ?? {});
}

/** Matched changes whose undo depends on something above the rule's limit. */
export function refusedMatches(preview: ActivationPreview): PreviewDrift[] {
  const blocked = new Set(preview.dependencies.filter((dependency) => dependency.overCeiling).flatMap((dependency) => dependency.requiredBy));
  return preview.matched.filter((drift) => blocked.has(drift.naturalKey));
}

/** What needs the reader before turning the rule on, worst first. */
export function previewAlerts(preview: ActivationPreview): PreviewAlert[] {
  const name = label(preview);
  const alerts: PreviewAlert[] = [];
  if (preview.blockers.includes("automation-halted") || preview.limits.automationHalted) {
    alerts.push({
      key: "halted", tone: "urgent", icon: "pause", title: "Automation is stopped",
      todo: `${askServerAdmin(null, "start automation again on the Keel server")} Then preview again.`, more: [], action: null,
    });
  }
  if (preview.blockers.includes("run-as-not-authorized") || !preview.runAs.authorized) {
    alerts.push({
      key: "run-as", tone: "urgent", icon: "person", title: "The account it acts as cannot undo changes",
      todo: "Give it the restorer role on the People page, then preview again.", more: [],
      action: { label: "Open People", href: "/people" },
    });
  }
  if (preview.unknowns.length) {
    const blocking = preview.blockers.includes("unknown-impact");
    alerts.push({
      key: "unknown", tone: blocking ? "urgent" : "soon", icon: "alert",
      title: `Keel cannot tell what ${plural(preview.unknowns.reduce((sum, unknown) => sum + Math.max(unknown.naturalKeys.length, 1), 0), "undo")} would affect`,
      todo: "Take a fresh backup, then preview again.",
      more: preview.unknowns.map((unknown) => `${unknown.naturalKeys.map(name).join(", ") || "A matched change"}: ${(UNKNOWN_WORDS[unknown.reason] ?? "Its effect is not known").replace(/^./, (first) => first.toLowerCase())}.`),
      action: { label: "Open backups", href: "/protect" },
    });
  }
  const refused = refusedMatches(preview);
  if (refused.length) {
    const over = preview.dependencies.filter((dependency) => dependency.overCeiling);
    alerts.push({
      key: "refused", tone: "soon", icon: "x-circle",
      title: `${plural(refused.length, "undo")} will be refused`,
      todo: "Each depends on something above the rule's limit. Undo it by hand, or raise the limit.",
      more: over.map((dependency) => `${name(dependency.naturalKey)} (${impactWords(dependency.blastRadius).toLowerCase()}) is needed by ${dependency.requiredBy.map(name).join(", ")}.`),
      action: { label: "Open changes", href: "/changes" },
    });
  }
  if (preview.unsupported.length) {
    alerts.push({
      key: "manual", tone: "soon", icon: "settings",
      title: `${plural(preview.unsupported.length, "change")} must be undone by hand`,
      todo: "Keel cannot do these automatically. Undo them from the Changes page.",
      more: preview.unsupported.map((entry) => `${OPERATION_WORDS[entry.operation] ?? "Change"} ${name(entry.naturalKey)}.`),
      action: { label: "Open changes", href: "/changes" },
    });
  }
  if (preview.matchedOverCeiling.length) {
    alerts.push({
      key: "left-alone", tone: "low", icon: "info",
      title: `${plural(preview.matchedOverCeiling.length, "change")} above its limit will be left alone`,
      todo: "Review it yourself on the Changes page.",
      more: preview.matchedOverCeiling.map((drift) => `${name(drift.naturalKey)}: ${impactWords(drift.blastRadius).toLowerCase()}.`),
      action: { label: "Open changes", href: "/changes" },
    });
  }
  if (preview.benchmarkFindings.state === "unavailable") {
    alerts.push({
      key: "checks-unread", tone: "low", icon: "info", title: "Security check results could not be read",
      todo: "Preview again in a few minutes.", more: [], action: null,
    });
  }
  const rank = { urgent: 0, soon: 1, low: 2 } as const;
  return alerts.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** Four numbers: what it would undo, refuse, leave alone, and the checks it touches. */
export function previewTiles(preview: ActivationPreview): StatTile[] {
  const refused = refusedMatches(preview).length;
  const undo = preview.matched.length - refused;
  const failing = preview.benchmarkFindings.findings.filter((finding) => finding.verdict === "fail").length;
  return [
    { key: "undo", label: "Would undo now", icon: "restore", value: String(undo), about: undo ? "within its limit" : "nothing matches now", tone: undo ? "fine" : "neutral" },
    { key: "refused", label: "Will refuse", icon: "x-circle", value: String(refused), about: refused ? "depend on something above its limit" : "none", tone: refused ? "soon" : "neutral" },
    { key: "left-alone", label: "Left alone", icon: "hide", value: String(preview.matchedOverCeiling.length + preview.unsupported.length), about: "above its limit or manual only", tone: preview.matchedOverCeiling.length + preview.unsupported.length ? "low" : "neutral" },
    {
      key: "checks", label: "Security checks", icon: "baselines",
      value: preview.benchmarkFindings.state === "unavailable" ? "Not read" : String(preview.benchmarkFindings.findings.length),
      about: preview.benchmarkFindings.state === "unavailable" ? "results could not be read" : failing ? `${failing} failing now` : "none failing",
      tone: preview.benchmarkFindings.state === "unavailable" ? "neutral" : failing ? "urgent" : preview.benchmarkFindings.findings.length ? "fine" : "neutral",
    },
  ];
}

/** Every item the rule would touch, grouped by what happens to it. */
export function previewGroups(preview: ActivationPreview): PreviewGroup[] {
  const name = label(preview);
  const refused = new Set(refusedMatches(preview).map((drift) => drift.naturalKey));
  const neededBy = (key: string) => preview.dependencies.filter((dependency) => dependency.overCeiling && dependency.requiredBy.includes(key)).map((dependency) => name(dependency.naturalKey));
  const matched: PreviewRow[] = [
    ...preview.matched.map((drift): PreviewRow => refused.has(drift.naturalKey)
      ? { key: drift.driftId, name: name(drift.naturalKey), what: CHANGE_WORDS[drift.changeType] ?? "Changed", impact: impactWords(drift.blastRadius), impactTone: impactTone(drift.blastRadius), outcome: "Will refuse", tone: "soon", note: `Needs ${neededBy(drift.naturalKey).join(", ")}` }
      : { key: drift.driftId, name: name(drift.naturalKey), what: CHANGE_WORDS[drift.changeType] ?? "Changed", impact: impactWords(drift.blastRadius), impactTone: impactTone(drift.blastRadius), outcome: "Will undo", tone: "fine", note: null }),
    ...preview.matchedOverCeiling.map((drift): PreviewRow => ({
      key: drift.driftId, name: name(drift.naturalKey), what: CHANGE_WORDS[drift.changeType] ?? "Changed", impact: impactWords(drift.blastRadius), impactTone: impactTone(drift.blastRadius), outcome: "Left alone", tone: "low", note: "Above its limit",
    })),
  ];
  const groups: PreviewGroup[] = [{ key: "matched", name: "Changes it matches", icon: "swap", rows: matched }];
  if (preview.dependencies.length) {
    groups.push({
      key: "dependencies", name: "What those undos depend on", icon: "link",
      rows: preview.dependencies.map((dependency) => ({
        key: dependency.naturalKey, name: name(dependency.naturalKey), what: `Needed by ${dependency.requiredBy.map(name).join(", ")}`,
        impact: impactWords(dependency.blastRadius), impactTone: impactTone(dependency.blastRadius),
        outcome: dependency.overCeiling ? "Above its limit" : "Within its limit", tone: dependency.overCeiling ? "urgent" : "fine", note: null,
      })),
    });
  }
  if (preview.unsupported.length) {
    groups.push({
      key: "manual", name: "Undo by hand", icon: "settings",
      rows: preview.unsupported.map((entry) => ({
        key: `${entry.naturalKey}|${entry.operation}`, name: name(entry.naturalKey), what: OPERATION_WORDS[entry.operation] ?? "Change",
        impact: "Not rated", impactTone: "neutral", outcome: "Manual only", tone: "low", note: null,
      })),
    });
  }
  if (preview.unknowns.length) {
    const blocking = preview.blockers.includes("unknown-impact");
    groups.push({
      key: "unknown", name: "Impact not known", icon: "alert",
      rows: preview.unknowns.map((unknown, index) => ({
        key: `${unknown.reason}-${index}`, name: unknown.naturalKeys.map(name).join(", ") || "A matched change", what: UNKNOWN_WORDS[unknown.reason] ?? "Its effect is not known",
        impact: "Not rated", impactTone: "neutral", ...(blocking ? { outcome: "Blocks turning on", tone: "urgent" as const } : { outcome: "Not known", tone: "soon" as const }), note: null,
      })),
    });
  }
  return groups;
}
