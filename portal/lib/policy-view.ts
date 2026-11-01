import type { IconName } from "@/components/shell/icons";
import { plainError } from "@/lib/error-words";
import type { BadgeTone } from "@/components/ui/badge";
import { itemKindName, itemService, plainKind, typeService } from "@/lib/baselines-view";
import type { RiskTone } from "@/lib/menu-status";
import type { Policy, PolicyAction } from "@/lib/policies";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { EngineRef } from "@/lib/sentences";

// Policies (portal audit, one design): the words of the page. A policy reads as an
// automatic rule: what it watches, what it does, who it acts as, and what it last did.
// Pure functions, shared by the list, the detail page, the harness and the tests; the
// components only lay things out. Codes and ids stay in Technical details.

export type RuleKind = "undo" | "approval" | "alert";
export type RuleState = "running" | "paused" | "stopped" | "off";

export const RULE_KIND_ORDER: RuleKind[] = ["undo", "approval", "alert"];

export const RULE_KINDS: Record<RuleKind, { label: string; icon: IconName; about: string; does: string; code: string }> = {
  undo: { label: "Undo automatically", icon: "restore", about: "Keel puts the setting back on its own", does: "Undoes the change automatically, then checks the setting is back.", code: "auto_remediate" },
  approval: { label: "Ask for approval", icon: "inbox", about: "Keel asks an approver first", does: "Asks an approver first, then undoes the change once it is approved.", code: "require_approval" },
  alert: { label: "Alert only", icon: "bell", about: "Keel tells you and changes nothing", does: "Sends an alert and changes nothing.", code: "alert" },
};

export const RULE_STATE_ORDER: RuleState[] = ["stopped", "paused", "running", "off"];

export const RULE_STATES: Record<RuleState, { label: string; plural: string; tone: BadgeTone; icon: IconName }> = {
  running: { label: "Running", plural: "Running", tone: "fine", icon: "check-circle" },
  paused: { label: "Paused", plural: "Paused", tone: "soon", icon: "pause" },
  stopped: { label: "Stopped: account needs repair", plural: "Stopped", tone: "urgent", icon: "alert" },
  off: { label: "Off", plural: "Off", tone: "neutral", icon: "hide" },
};

export function ruleKind(policy: Pick<Policy, "action">): RuleKind {
  return policy.action === "auto_remediate" ? "undo" : policy.action === "require_approval" ? "approval" : "alert";
}

export function ruleState(policy: Pick<Policy, "enabled" | "paused_at" | "run_as_repair_required">): RuleState {
  if (!policy.enabled) return "off";
  if (policy.run_as_repair_required) return "stopped";
  if (policy.paused_at) return "paused";
  return "running";
}

/** The risk the rule may touch, as a tone: low risk blue, affects access amber, lockout red. */
export function riskTone(blastRadius: string | null | undefined): RiskTone {
  return blastRadius === "tenant-lockout" ? "urgent" : blastRadius === "access-affecting" ? "soon" : "low";
}

const RISK_WORDS: Record<string, string> = { cosmetic: "Low risk", "access-affecting": "Affects access", "tenant-lockout": "Could lock out admins" };

/** "Low risk" / "Affects access" / "Could lock out admins"; "Any risk" when unrated. */
export function riskWords(blastRadius: string | null | undefined): string {
  return (blastRadius && RISK_WORDS[blastRadius]) || "Any risk";
}

function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The kind of thing a rule watches, in words: "sign-in rules", "groups", "anything". */
export function kindWords(policy: Pick<Policy, "resource_type" | "natural_key_glob">): string {
  const type = watchedType(policy);
  return type ? plural(plainKind(type).toLowerCase()) : "anything";
}

/** The stored type the rule watches: its own, or the one its name pattern starts with. */
export function watchedType(policy: Pick<Policy, "resource_type" | "natural_key_glob">): string | null {
  if (policy.resource_type) return policy.resource_type;
  const glob = policy.natural_key_glob;
  if (!glob || !glob.includes(":")) return null;
  // "*:Admin*" watches every kind, so it has no single type.
  const type = glob.split(":")[0];
  return type && !/[*?]/.test(type) ? type : null;
}

/** The name pattern a rule watches, without its type: "Admin*"; null for every name. */
export function namePattern(policy: Pick<Policy, "natural_key_glob">): string | null {
  const glob = policy.natural_key_glob;
  if (!glob) return null;
  const pattern = glob.includes(":") ? glob.split(":").slice(1).join(":") : glob;
  return pattern && pattern !== "*" ? pattern : null;
}

const CHANGE_NOUNS: Record<string, string> = { added: "additions of", modified: "changes to", removed: "removals of" };
const CHANGE_WORDS: Record<string, string> = { added: "Added", modified: "Changed", removed: "Removed" };

/** What the rule matches, in words: "low-risk changes to anything", "changes to sign-in rules that could lock out admins". */
export function matchWords(policy: Pick<Policy, "resource_type" | "natural_key_glob" | "change_type" | "blast_radius">): string {
  const noun = (policy.change_type && CHANGE_NOUNS[policy.change_type]) || "changes to";
  const pattern = namePattern(policy);
  const subject = `${kindWords(policy)}${pattern ? ` with a name like “${pattern}”` : ""}`;
  switch (policy.blast_radius) {
    case "cosmetic": return `low-risk ${noun} ${subject}`;
    case "access-affecting": return `${noun} ${subject} that affect access`;
    case "tenant-lockout": return `${noun} ${subject} that could lock out admins`;
    default: return `${noun} ${subject}`;
  }
}

function rateWindow(seconds: number | null): string {
  if (seconds === 3600) return "an hour";
  if (seconds === 86_400) return "a day";
  if (seconds === 60) return "a minute";
  if (seconds && seconds % 3600 === 0) return `every ${seconds / 3600} hours`;
  if (seconds && seconds % 60 === 0) return `every ${seconds / 60} minutes`;
  return `every ${seconds ?? "?"} seconds`;
}

/** "50 an hour", or null when the rule has no limit. */
export function rateWords(policy: Pick<Policy, "max_actions_per_window" | "window_seconds">): string | null {
  if (policy.max_actions_per_window == null) return null;
  return `${policy.max_actions_per_window} ${rateWindow(policy.window_seconds)}`;
}

/** The one sentence of a rule: what it does to what, and how often. */
export function ruleSentence(policy: Pick<Policy, "action" | "resource_type" | "natural_key_glob" | "change_type" | "blast_radius" | "max_actions_per_window" | "window_seconds">): string {
  const rate = rateWords(policy);
  const limit = rate ? `, up to ${rate}` : "";
  switch (ruleKind(policy)) {
    case "undo": return `Undoes ${matchWords(policy)}${limit}.`;
    case "approval": return `Asks an approver before undoing ${matchWords(policy)}${limit}.`;
    default: return `Alerts on ${matchWords(policy)} and changes nothing.`;
  }
}

/** What it watches, as chips: the kind of thing, the change, the risk and the name pattern. */
export function watchChips(policy: Pick<Policy, "resource_type" | "natural_key_glob" | "change_type" | "blast_radius">): { label: string; icon?: IconName; hint?: string }[] {
  const type = watchedType(policy);
  const pattern = namePattern(policy);
  return [
    type ? { label: plural(plainKind(type)), icon: typeService(type).icon, hint: typeService(type).name } : { label: "Anything", icon: "cloud" },
    { label: policy.change_type ? CHANGE_WORDS[policy.change_type] ?? "Changed" : "Any change" },
    { label: riskWords(policy.blast_radius) },
    ...(pattern ? [{ label: `Name like “${pattern}”` }] : []),
  ];
}

/** The most risky change a rule may touch, in words. */
export function ceilingWords(policy: Pick<Policy, "max_blast_radius">): string {
  return RISK_WORDS[policy.max_blast_radius] ?? "Any risk";
}

/** The account a rule acts as, as a person reference; null for rules that act as nobody. */
export function runAsRef(policy: Pick<Policy, "run_as_principal" | "run_as_principal_id">): EngineRef | null {
  const ref = policy.run_as_principal;
  if (!ref) return policy.run_as_principal_id ? { kind: "person", id: policy.run_as_principal_id, name: null, readable: false } : null;
  return { kind: "person", id: ref.id, name: ref.name === ref.email ? null : ref.name, email: ref.email, readable: ref.readable };
}

/** The last thing it did, as a short clause: "Last undid Branch offices 2 hours ago". */
export function lastActionWords(policy: Policy, now: string): string {
  const state = ruleState(policy);
  if (state === "paused") return `Hit its limit ${ago(policy.paused_at, now)}`;
  if (state === "stopped") return "Needs the restorer role";
  if (state === "off" && ruleKind(policy) === "undo") return "Preview to turn on";
  if (!policy.last_action_at) return "Has not acted yet";
  const verb = policy.last_action_status === "failed" ? "Last failed on" : policy.last_action_status === "queued" ? "About to undo" : ruleKind(policy) === "approval" ? "Last asked about" : "Last undid";
  const name = policy.last_action_name ?? (policy.last_action_resource_type || policy.resource_type ? `an unnamed ${plainKind(policy.last_action_resource_type ?? policy.resource_type ?? "").toLowerCase()}` : "an unnamed setting");
  return `${verb} ${name} ${ago(policy.last_action_at, now)}`;
}

export interface RuleCounts { total: number; running: number; paused: number; stopped: number; off: number; undoOff: number; actionsWeek: number }

export function ruleCounts(policies: Policy[]): RuleCounts {
  const counts: RuleCounts = { total: policies.length, running: 0, paused: 0, stopped: 0, off: 0, undoOff: 0, actionsWeek: 0 };
  for (const policy of policies) {
    counts[ruleState(policy)] += 1;
    if (!policy.enabled && ruleKind(policy) === "undo") counts.undoOff += 1;
    counts.actionsWeek += policy.actions_last_7_days ?? 0;
  }
  return counts;
}

function rules(count: number): string {
  return `${count} ${count === 1 ? "rule" : "rules"}`;
}

/** The header pill: Urgent when halted or stopped, Check soon when paused, Fine otherwise. */
export function rulesStatus(counts: RuleCounts, halted: boolean): { tone: RiskTone; label: string } {
  if (halted) return { tone: "urgent", label: "Automation halted" };
  if (counts.stopped) return { tone: "urgent", label: `${counts.stopped} stopped` };
  if (counts.paused) return { tone: "soon", label: `${counts.paused} paused` };
  return { tone: "fine", label: "Automation on" };
}

export interface RulesVerdict { text: string; detail?: string; tone: "urgent" | "soon" | "fine" | "neutral"; resume: Policy | null }

/** The page's one sentence, and the rule that Resume would resume. */
export function rulesVerdict(policies: Policy[], halted: boolean, now: string): RulesVerdict {
  const counts = ruleCounts(policies);
  const stopped = policies.find((policy) => ruleState(policy) === "stopped") ?? null;
  const paused = policies.find((policy) => ruleState(policy) === "paused") ?? null;
  if (halted) {
    return { text: "Automation is stopped by an operator. No rule acts until it is started again.", detail: "Turning rules on or off here changes nothing until then.", tone: "urgent", resume: null };
  }
  if (stopped) {
    const more = counts.stopped > 1 ? ` ${counts.stopped - 1} more ${counts.stopped === 2 ? "is" : "are"} stopped too.` : "";
    return { text: `${stopped.name} is stopped: the account it acts as needs repair.${more}`, detail: "Give that account the restorer role, then resume the rule.", tone: "urgent", resume: null };
  }
  if (paused) {
    const more = counts.paused > 1 ? ` ${counts.paused - 1} more ${counts.paused === 2 ? "is" : "are"} paused too.` : "";
    return { text: `${paused.name} paused itself after hitting its limit ${ago(paused.paused_at, now)}.${more}`, detail: "Nothing new is undone by it until someone resumes it.", tone: "soon", resume: paused };
  }
  if (counts.total === 0) return { text: "No automatic rules yet. Keel only reports changes; nothing acts on its own.", tone: "neutral", resume: null };
  if (counts.running === 0) return { text: `${rules(counts.off)} set up, all off. Keel only reports changes until one is turned on.`, tone: "neutral", resume: null };
  return {
    text: `${rules(counts.running)} running; nothing needs you.`,
    detail: `${counts.actionsWeek} ${counts.actionsWeek === 1 ? "action" : "actions"} this week${counts.off ? `, ${rules(counts.off)} off` : ""}.`,
    tone: "fine", resume: null,
  };
}

export type RuleStateFilter = "running" | "paused" | "off";
export const RULE_STATE_FILTERS: RuleStateFilter[] = ["running", "paused", "off"];
// States add up (`state=running,off` shows either); what it does narrows.
export interface RuleFilters { states: RuleStateFilter[]; what: RuleKind | null }

/** The filters in the address: `state=` (paused covers stopped too) and `what=`. */
export function parseFilters(get: (key: string) => string | null): RuleFilters {
  const picked = (get("state") ?? "").split(",");
  const what = get("what");
  return {
    states: RULE_STATE_FILTERS.filter((key) => picked.includes(key)),
    what: what === "undo" || what === "approval" || what === "alert" ? what : null,
  };
}

export function ruleMatches(policy: Policy, filters: RuleFilters): boolean {
  if (filters.what && ruleKind(policy) !== filters.what) return false;
  if (filters.states.length && !filters.states.some((key) => ruleInState(policy, key))) return false;
  return true;
}

/** "paused or stopped rules" — the filter note's words. */
/** True when the rule is in that tile's state; Paused counts stopped rules too. */
export function ruleInState(policy: Policy, key: RuleStateFilter): boolean {
  const state = ruleState(policy);
  return key === "paused" ? state === "paused" || state === "stopped" : state === key;
}

export function filterWords(filters: RuleFilters): string {
  const state = filters.states.map((key) => (key === "paused" ? "paused or stopped" : key)).join(" or ");
  const what = filters.what ? RULE_KINDS[filters.what].label.toLowerCase() : "";
  return `${[state, what].filter(Boolean).join(" ")} rules`.trim();
}

export const ACTION_OUTCOMES: Record<string, { label: string; tone: BadgeTone; icon: IconName }> = {
  executed: { label: "Undone", tone: "fine", icon: "check-circle" },
  failed: { label: "Failed", tone: "urgent", icon: "x-circle" },
  queued: { label: "Waiting", tone: "soon", icon: "clock" },
};

export function actionOutcome(action: Pick<PolicyAction, "status">): { label: string; tone: BadgeTone; icon: IconName } {
  return ACTION_OUTCOMES[action.status] ?? { label: "Recorded", tone: "neutral", icon: "info" };
}

/** The name of what an action acted on, never its key: "Branch offices". */
export function actionName(action: Pick<PolicyAction, "name" | "resource_type">): string {
  return action.name ?? `Unnamed ${action.resource_type ? plainKind(action.resource_type).toLowerCase() : "setting"}`;
}

/** "Trusted location · Entra ID · changed" */
export function actionKindLine(action: Pick<PolicyAction, "resource_type" | "change_type"> & Partial<Pick<PolicyAction, "name" | "template_family" | "built_in">>): string {
  const item = action.resource_type ? { resourceType: action.resource_type, name: action.name ?? null, templateFamily: action.template_family ?? null, builtIn: action.built_in ?? null } : null;
  const parts = item ? [itemKindName(item), itemService(item).name] : ["Setting"];
  if (action.change_type) parts.push((CHANGE_WORDS[action.change_type] ?? "Changed").toLowerCase());
  return parts.join(" · ");
}

/** Why an undo failed, in words; the full error stays in Technical details. */
export function failureWords(error: string | null): string {
  const first = (error ?? "").split("\n")[0].replace(/^[A-Za-z]*Error:\s*/, "");
  if (/\b403\b|Authorization_RequestDenied|Forbidden/i.test(first)) return "Microsoft refused the write: not enough rights";
  if (/\b429\b|throttl/i.test(first)) return "Microsoft throttled the request";
  if (/\b404\b|not found/i.test(first)) return "The setting no longer exists";
  if (/\b(5\d\d)\b|timed? ?out/i.test(first)) return "Microsoft did not answer in time";
  // Anything else in plain words; the raw error is behind "Show details".
  return plainError(error).cause.replace(/\.$/, "");
}

/** One plain line under the outcome: why it failed, or when it ran. */
export function actionLine(action: PolicyAction, now: string): string {
  if (action.status === "failed") return `${failureWords(action.error)} · ${ago(action.finished_at ?? action.queued_at, now)}`;
  if (action.status === "queued") return `Waiting to run · queued ${ago(action.queued_at, now)}`;
  return `Put back · ${ago(action.finished_at ?? action.queued_at, now)}`;
}

/** "Created 12 Sept 2026, 08:00 UTC" */
export function createdWords(policy: Pick<Policy, "created_at">): string {
  return `Created ${formatTimestamp(policy.created_at)}`;
}

/** What turning rules off does, before it happens. */
export function turnOffDetail(count: number, undoRules: number, alreadyOff: number): string {
  const parts = [`${count === 1 ? "It stops" : "They stop"} acting on new changes.`];
  if (undoRules) parts.push(`${undoRules === 1 ? "The undo rule needs" : `${undoRules} undo rules need`} a preview to turn back on.`);
  if (alreadyOff) parts.push(`${alreadyOff === 1 ? "1 is" : `${alreadyOff} are`} already off and ${alreadyOff === 1 ? "stays" : "stay"} as ${alreadyOff === 1 ? "it is" : "they are"}.`);
  return parts.join(" ");
}

/** Why a change was refused, in words. */
export function changeRefusal(status: number, code: string | undefined, change: "turn-off" | "turn-on" | "resume"): string {
  if (code === "activation_preview_required") return "Undo rules turn on from a preview on the rule's page.";
  if (status === 409) return change === "turn-off" ? "The rule could not be changed." : "The account this rule acts as can no longer undo changes. Give it the restorer role first.";
  if (status === 403) return "You do not have the policies permission.";
  return "The rule could not be changed. Try again in a minute.";
}

/** One setting a rule edit or delete changed, as its audit record holds it. */
export interface RuleChangeField { field: string; before: unknown; after: unknown }

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// Each recorded setting in the words the rule sheet uses. The limit is one row: its
// count and its window read together ("50 an hour").
const RULE_FIELD_WORDS: Record<string, { label: string; words: (value: unknown) => string }> = {
  action: { label: "What it does", words: (value) => RULE_KINDS[ruleKind({ action: str(value) ?? "alert" } as Pick<Policy, "action">)].label },
  enabled: { label: "On or off", words: (value) => (value === true ? "On" : "Off") },
  name: { label: "Name", words: (value) => str(value) ?? "No name" },
  resourceType: { label: "Type of thing", words: (value) => (str(value) ? plainKind(String(value)) : "Anything") },
  naturalKeyGlob: { label: "Name like", words: (value) => namePattern({ natural_key_glob: str(value) }) ?? "Any name" },
  changeType: { label: "Change", words: (value) => (str(value) && CHANGE_WORDS[String(value)]) || "Any change" },
  blastRadius: { label: "Risk", words: (value) => riskWords(str(value)) },
  maxBlastRadius: { label: "Most risky it may touch", words: (value) => RISK_WORDS[String(value)] ?? "Any risk" },
};
const RULE_FIELD_ORDER = ["action", "enabled", "name", "resourceType", "naturalKeyGlob", "changeType", "blastRadius", "maxBlastRadius", "limit"];

/**
 * The settings a rule edit or delete changed, in words, in the order the rule sheet
 * shows them. A delete has no "after". Unknown fields are dropped.
 */
export function ruleChangeFields(change: "edited" | "deleted", fields: unknown): { path: string; before: string; after: string | null }[] {
  const list = (Array.isArray(fields) ? fields : []).filter((entry): entry is RuleChangeField => !!entry && typeof entry === "object" && typeof (entry as RuleChangeField).field === "string");
  const byField = new Map(list.map((entry) => [entry.field, entry]));
  const rows: { order: number; path: string; before: string; after: string | null }[] = [];
  for (const entry of list) {
    const words = RULE_FIELD_WORDS[entry.field];
    if (words) rows.push({ order: RULE_FIELD_ORDER.indexOf(entry.field), path: words.label, before: words.words(entry.before), after: change === "deleted" ? null : words.words(entry.after) });
  }
  // The engine records the limit's count and window together whenever either changes.
  const count = byField.get("maxActionsPerWindow");
  const window = byField.get("windowSeconds");
  if (count || window) {
    const side = (which: "before" | "after") => rateWords({ max_actions_per_window: num(count?.[which]), window_seconds: num(window?.[which]) }) ?? "No limit";
    rows.push({ order: RULE_FIELD_ORDER.indexOf("limit"), path: "Limit", before: side("before"), after: change === "deleted" ? null : side("after") });
  }
  return rows.sort((a, b) => a.order - b.order).map(({ path, before, after }) => ({ path, before, after }));
}
