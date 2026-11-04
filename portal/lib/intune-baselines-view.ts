// Intune security baselines (engine/benchmarks/intuneBaselines.mjs): every setting of
// every Microsoft baseline version, matched by setting against every settings catalog
// policy in the newest complete backup. This file shapes the engine's results for the
// page and holds the page's words.

import type { BadgeTone } from "@/components/ui/badge";
import type { IconName } from "@/components/shell/icons";
import type { RiskTone } from "@/lib/menu-status";

export type BaselineResult = "conflict" | "different" | "not-configured" | "unknown" | "match";

export const BASELINE_RESULTS: Record<BaselineResult, { label: string; plural: string; small: string; badge: BadgeTone; tone: RiskTone | null; icon: IconName; rank: number }> = {
  conflict: { label: "Conflict", plural: "Conflicts", small: "Two or more policies set different values", badge: "urgent", tone: "urgent", icon: "alert", rank: 0 },
  different: { label: "Different", plural: "Different", small: "Set, but not to Microsoft's value", badge: "urgent", tone: "urgent", icon: "x-circle", rank: 1 },
  "not-configured": { label: "Not configured", plural: "Not configured", small: "No policy sets it", badge: "soon", tone: "soon", icon: "clock", rank: 2 },
  unknown: { label: "Could not check", plural: "Could not check", small: "No complete backup of the policies yet", badge: "neutral", tone: null, icon: "info", rank: 3 },
  match: { label: "Matches", plural: "Matches", small: "Set to Microsoft's value", badge: "fine", tone: "fine", icon: "check-circle", rank: 4 },
};

export const RESULT_ORDER = (Object.keys(BASELINE_RESULTS) as BaselineResult[]).sort((a, b) => BASELINE_RESULTS[a].rank - BASELINE_RESULTS[b].rank);

export interface BaselineSettingRow {
  // Unique on the page: the baseline version and the setting.
  key: string;
  // The settingDefinitionId: shown only under Technical details.
  id: string;
  name: string;
  category: string;
  result: BaselineResult;
  // Microsoft's value in words; null when Microsoft leaves the value to the admin.
  expected: string | null;
  setBy: { policyName: string; value: string }[];
  baselineKey: string;
}

export interface BaselineVersion {
  key: string;
  name: string;
  version: string | null;
  // Microsoft's lifecycle: active is the current version.
  current: boolean;
  state: string | null;
  platforms: string | null;
  counts: Record<BaselineResult, number>;
  settings: BaselineSettingRow[];
}

export interface IntuneBaselineData {
  generatedAt: string;
  templates: { readAt: string; outcome: string; error: string | null; failures: { templateId: string; name: string | null; error: string }[] } | null;
  lastFailure: { readAt: string; error: string | null } | null;
  policies: { snapshotId: string; readAt: string | null; count: number } | null;
  baselines: BaselineVersion[];
}

// The engine's shapes (untyped JavaScript), as far as this file reads them.
interface EngineSetting { id: string; name: string; category: string | null; expected: string[] | null; labels: Record<string, string>; result: BaselineResult; setBy: { policyName: string | null; values: string[] }[] }
interface EngineBaseline { templateId: string; name: string; version: string | null; state: string | null; platforms: string | null; counts: Record<BaselineResult, number>; settings: EngineSetting[] }
export interface EngineBaselineResults {
  templates: IntuneBaselineData["templates"];
  lastFailure: IntuneBaselineData["lastFailure"];
  policies: IntuneBaselineData["policies"];
  baselines: EngineBaseline[];
}

export const OTHER_CATEGORY = "Other settings";

/** One value in words: the option's name when Microsoft gives one, otherwise the value
 *  itself, without the setting's id in front of an option id. */
export function valueWords(settingId: string, value: string, labels: Record<string, string>): string {
  if (labels[value]) return labels[value];
  if (value.startsWith(`${settingId}_`)) return value.slice(settingId.length + 1).replaceAll("_", " ");
  return value;
}

function valuesWords(settingId: string, values: string[], labels: Record<string, string>): string {
  return values.map((value) => valueWords(settingId, value, labels)).join(", ") || "Set, no value";
}

/** The engine's results as the page shows them: words instead of option ids, and only
 *  what the page needs, so a tenant with every baseline stays small to send. */
export function shapeBaselines(results: EngineBaselineResults, generatedAt: string): IntuneBaselineData {
  const baselines = results.baselines.map((baseline) => {
    const key = baseline.templateId;
    return {
      key,
      name: baseline.name,
      version: baseline.version,
      current: (baseline.state ?? "active").toLowerCase() === "active",
      state: baseline.state,
      platforms: baseline.platforms,
      counts: baseline.counts,
      settings: baseline.settings.map((setting) => ({
        key: `${key}:${setting.id}`,
        id: setting.id,
        name: setting.name,
        category: setting.category ?? OTHER_CATEGORY,
        result: setting.result,
        expected: setting.expected === null ? null : valuesWords(setting.id, setting.expected, setting.labels ?? {}),
        setBy: setting.setBy.map((entry) => ({ policyName: entry.policyName ?? "A policy with no name", value: valuesWords(setting.id, entry.values, setting.labels ?? {}) })),
        baselineKey: key,
      })),
    };
  }).sort(byBaseline);
  return { generatedAt, templates: results.templates, lastFailure: results.lastFailure, policies: results.policies, baselines };
}

/** Baselines by name, the current version first, then newer versions before older. */
export function byBaseline(a: Pick<BaselineVersion, "name" | "version" | "current">, b: Pick<BaselineVersion, "name" | "version" | "current">): number {
  return a.name.localeCompare(b.name) || Number(b.current) - Number(a.current) || (b.version ?? "").localeCompare(a.version ?? "", undefined, { numeric: true });
}

export function baselineLabel(baseline: Pick<BaselineVersion, "name" | "version">): string {
  return baseline.version ? `${baseline.name} (${baseline.version})` : baseline.name;
}

export function settingsWord(count: number): string {
  return `${count} ${count === 1 ? "setting" : "settings"}`;
}

export function totalCounts(baselines: readonly Pick<BaselineVersion, "counts">[]): Record<BaselineResult, number> {
  const counts = Object.fromEntries(RESULT_ORDER.map((result) => [result, 0])) as Record<BaselineResult, number>;
  for (const baseline of baselines) for (const result of RESULT_ORDER) counts[result] += baseline.counts[result] ?? 0;
  return counts;
}

/** The one sentence at the top: what needs attention first. */
export function baselinesVerdict(data: IntuneBaselineData, shown: readonly BaselineVersion[]): { text: string; detail: string; tone: "urgent" | "soon" | "fine" | "neutral" } {
  if (!data.templates) {
    return {
      tone: "neutral",
      text: data.lastFailure ? "Keel could not read Microsoft's security baselines from the tenant yet." : "Microsoft's security baselines have not been read yet.",
      detail: "They are read after the next backup of Intune settings, at most once a day.",
    };
  }
  if (!data.baselines.length) return { tone: "neutral", text: "This tenant shows no Intune security baselines.", detail: "Microsoft publishes them only to tenants with Intune." };
  const counts = totalCounts(shown);
  const total = RESULT_ORDER.reduce((sum, result) => sum + counts[result], 0);
  if (!data.policies) return { tone: "neutral", text: `${settingsWord(total)} could not be checked yet.`, detail: "No backup has read the settings catalog policies in full. Run a backup of Intune settings." };
  const off = counts.conflict + counts.different;
  if (off) {
    return {
      tone: "urgent",
      text: `${settingsWord(off)} ${off === 1 ? "differs" : "differ"} from Microsoft's security baselines.`,
      detail: `${counts.conflict ? `${counts.conflict} set to different values by two or more policies. ` : ""}${counts["not-configured"]} more not configured. ${counts.match} of ${total} match.`,
    };
  }
  if (counts["not-configured"]) return { tone: "soon", text: `${settingsWord(counts["not-configured"])} from Microsoft's security baselines ${counts["not-configured"] === 1 ? "is" : "are"} not configured.`, detail: `${counts.match} of ${total} match. None is set to another value.` };
  return { tone: "fine", text: `All ${settingsWord(total)} match Microsoft's security baselines.`, detail: "Every setting is set to Microsoft's value by your policies." };
}

/** A row's one line of what was found. */
export function foundLine(row: BaselineSettingRow): string {
  switch (row.result) {
    case "match": return row.setBy.length === 1 ? `Set by ${row.setBy[0].policyName}` : `Set the same way by ${row.setBy.length} policies`;
    case "different": return `Yours: ${row.setBy[0]?.value ?? ""}${row.setBy.length === 1 ? ` (${row.setBy[0].policyName})` : ` (${row.setBy.length} policies)`}`;
    case "conflict": return `${row.setBy.length} policies disagree`;
    case "not-configured": return "No settings catalog policy sets it";
    default: return "Not checked: no complete backup of the policies";
  }
}

/** The header's status: the worst result among the current versions. */
export function baselinesStatus(data: IntuneBaselineData): { tone: RiskTone; label: string } | undefined {
  if (!data.templates || !data.policies || !data.baselines.length) return undefined;
  const counts = totalCounts(data.baselines.filter((baseline) => baseline.current));
  const off = counts.conflict + counts.different;
  if (off) return { tone: "urgent", label: `${off} differ` };
  if (counts["not-configured"]) return { tone: "soon", label: `${counts["not-configured"]} not configured` };
  return { tone: "fine", label: "All match" };
}
