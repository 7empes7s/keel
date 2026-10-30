// Wave 2 CMP: the shapes engine/govern/compare.mjs returns, and the words the Compare
// page uses for them. Pure, so the UI harness renders the real page from fixtures.
import { fieldWords, valueWords } from "@/lib/changes-view";
import { readableValue } from "@/lib/changed-values";
import { formatTimestamp } from "@/lib/presentation";

export type ChangeType = "added" | "removed" | "changed";

export interface CompareSide {
  kind: "snapshot" | "live";
  tenantRef: string;
  snapshotId: string | null;
  at: string | null;
  latestStored?: string[];
}

export interface CompareField {
  path: string;
  kind: string;
  before: unknown;
  after: unknown;
}

export interface SettingsItem {
  naturalKey: string;
  name: string | null;
  changeType: ChangeType;
  blastRadius: string | null;
  fields?: CompareField[];
  fieldsTotal?: number;
}

export interface SettingsGroup {
  service: string;
  resourceType: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  total: number;
  items: SettingsItem[];
}

export interface SettingsSection {
  totals: { added: number; removed: number; changed: number; unchanged: number; notCompared: number; unmatched: number };
  groups: SettingsGroup[];
  notCompared: { resourceType: string; service: string; left: string; right: string }[];
  unmatched: { resourceType: string; service: string; left: number; right: number }[];
}

export interface WorkloadItem {
  resourceKey: string;
  /** The name the workload read carries (a site's title), when it has one. */
  name?: string | null;
  changeType: ChangeType;
  fields?: CompareField[];
  fieldsTotal?: number;
}

export interface WorkloadGroup {
  service: string;
  workload: string;
  state: "compared" | "not-compared";
  reason?: "not-collected" | "collection-failed";
  left: { collectionId: string; outcome: string; at: string | null } | null;
  right: { collectionId: string; outcome: string; at: string | null } | null;
  added?: number;
  removed?: number;
  changed?: number;
  unchanged?: number;
  unverified?: number;
  unverifiedFields?: number;
  unmatched?: number;
  total?: number;
  items?: WorkloadItem[];
}

export interface WorkloadsSection {
  totals: { added: number; removed: number; changed: number; unchanged: number; notCompared: number };
  groups: WorkloadGroup[];
}

export interface ContentItem {
  itemKey: string;
  name: string | null;
  kind: string | null;
  changeType: ChangeType;
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
}

export interface ContentContainer {
  container: string;
  added: number;
  removed: number;
  changed: number;
  items: ContentItem[];
}

export interface ContentItemsSection {
  by: "item";
  totals: { added: number; removed: number; changed: number };
  shown: number;
  total: number;
  groups: { service: string; workload: string; leftItems: number; rightItems: number; added: number; removed: number; changed: number; containers: ContentContainer[] }[];
}

export interface ContentHoldingsSection {
  by: "holdings";
  totals: { inBoth: number; onlyLeft: number; onlyRight: number };
  groups: { service: string; workload: string; leftItems: number; rightItems: number; leftBytes: number; rightBytes: number; inBoth: number; onlyLeft: number; onlyRight: number }[];
}

export interface CompareResult {
  version: number;
  mode: "snapshots" | "live" | "tenants";
  portable: boolean;
  generatedAt: string;
  left: CompareSide;
  right: CompareSide;
  settings: SettingsSection | null;
  workloads: WorkloadsSection | null;
  content: ContentItemsSection | ContentHoldingsSection | null;
  /** Names for the ids inside setting values (lower-case id to name), from both backups. */
  names?: Record<string, string>;
}

export interface CompareSnapshotOption {
  id: string;
  completedAt: string | null;
  resourceCount: number;
}

export interface CompareTenant {
  tenantRef: string;
  label: string;
  own: boolean;
  snapshots: CompareSnapshotOption[];
}

export interface CompareInput {
  from: string;
  to: string;
}

export type CompareProblem = "snapshot-not-found" | "snapshot-incomplete" | "same-snapshot" | "too-few-snapshots";

export interface CompareData {
  generatedAt: string;
  tenants: CompareTenant[];
  input: CompareInput | null;
  result: CompareResult | null;
  problem: CompareProblem | null;
}

type SearchParams = Record<string, string | string[] | undefined>;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two snapshots asked for, or null when the address names none (or names them badly). */
export function compareInputFrom(params: SearchParams): CompareInput | null {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const from = one(params.from).trim();
  const to = one(params.to).trim();
  return ID.test(from) && ID.test(to) ? { from, to } : null;
}

/** "This tenant" first, then every other tenant numbered in a stable order. */
export function labelTenants(sources: { tenantRef: string; snapshots: CompareSnapshotOption[] }[], own: string): CompareTenant[] {
  const others = sources.filter((tenant) => tenant.tenantRef !== own).sort((a, b) => a.tenantRef.localeCompare(b.tenantRef));
  const mine = sources.find((tenant) => tenant.tenantRef === own);
  return [
    { tenantRef: own, label: "This tenant", own: true, snapshots: mine?.snapshots ?? [] },
    ...others.map((tenant, index) => ({ ...tenant, label: `Other tenant ${index + 1}`, own: false })),
  ];
}

/** Without a choice, the page compares this tenant's two newest snapshots. */
export function defaultInput(tenants: CompareTenant[]): CompareInput | null {
  const own = tenants.find((tenant) => tenant.own)?.snapshots ?? [];
  return own.length >= 2 ? { from: own[1].id, to: own[0].id } : null;
}

export function snapshotWords(option: CompareSnapshotOption): string {
  return `${formatTimestamp(option.completedAt)} · ${option.resourceCount.toLocaleString("en-GB")} objects`;
}

function tenantLabel(tenants: CompareTenant[], tenantRef: string): string {
  return tenants.find((tenant) => tenant.tenantRef === tenantRef)?.label ?? "another tenant";
}

/** A side as a person reads it: "the backup of 2 Oct 2026, 09:12 UTC" (with its tenant when two are compared). */
export function sideWords(side: CompareSide, tenants: CompareTenant[], portable: boolean): string {
  const when = side.kind === "live" ? "the tenant as it is now" : `the backup of ${formatTimestamp(side.at)}`;
  return portable ? `${when} (${tenantLabel(tenants, side.tenantRef)})` : when;
}

export function differenceTotals(result: CompareResult) {
  const settings = result.settings ? result.settings.totals.added + result.settings.totals.removed + result.settings.totals.changed : 0;
  const workloads = result.workloads ? result.workloads.totals.added + result.workloads.totals.removed + result.workloads.totals.changed : 0;
  const content = !result.content ? 0 : result.content.by === "item" ? result.content.total : result.content.totals.onlyLeft + result.content.totals.onlyRight;
  return { settings, workloads, content, total: settings + workloads + content };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;

export function compareVerdict(data: CompareData): { text: string; tone: "good" | "attention" | "critical" } {
  if (data.problem === "too-few-snapshots") return { text: "Compare needs two complete backups, and this tenant does not have two yet.", tone: "attention" };
  if (data.problem === "same-snapshot") return { text: "Choose two different backups to compare.", tone: "attention" };
  if (data.problem) return { text: "One of the chosen backups is not available. Choose another pair.", tone: "attention" };
  if (!data.result) return { text: "Choose two backups to compare.", tone: "attention" };
  const { total } = differenceTotals(data.result);
  // Kinds or workloads not compared, objects that cannot be matched across tenants, and
  // workload resources one side read only in part all leave something unchecked.
  const workloadGaps = (data.result.workloads?.groups ?? []).reduce((sum, group) => sum + (group.unverified ?? 0) + (group.unmatched ?? 0), 0);
  const notCompared = (data.result.settings?.totals.notCompared ?? 0) + (data.result.settings?.totals.unmatched ?? 0)
    + (data.result.workloads?.totals.notCompared ?? 0) + workloadGaps;
  const two = data.result.portable ? "the two tenants" : "the two backups";
  if (total === 0 && notCompared === 0) return { text: `Nothing differs between ${two}.`, tone: "good" };
  if (total === 0) return { text: `Nothing differs in what both sides read; ${plural(notCompared, "part")} could not be compared.`, tone: "attention" };
  return { text: `${plural(total, "difference")} between ${two}.`, tone: "attention" };
}

export const CHANGE_WORDS: Record<ChangeType, string> = { added: "Added", removed: "Removed", changed: "Changed" };

export const WORKLOAD_LABELS: Record<string, string> = {
  "exchange-mailbox-settings": "Mailbox settings",
  "exchange-mail-flow": "Mail flow",
  "exchange-extended": "Exchange organization settings",
  "exchange-role-groups": "Exchange admin role groups",
  "exchange-distribution-groups": "Distribution lists and group mail settings",
  "exchange-recipients": "Shared mailboxes, rooms, contacts and mailbox access",
  "exchange-org-access": "Exchange sharing and client access",
  "exchange-org-defaults": "Exchange transport and new mailbox defaults",
  "exchange-mail": "Mail, calendars and contacts",
  "group-conversations": "Group conversations",
  "teams-settings": "Teams settings",
  "teams-org-policies": "Teams policies",
  "teams-voice-policies": "Teams voice policies",
  "teams-collaboration-policies": "Teams external access, channel and files policies",
  "teams-meeting-settings": "Teams meeting settings, encryption and recording",
  teams: "Teams",
  "purview-labels": "Sensitivity labels",
  "purview-governance": "Purview governance",
  "purview-retention-dlp": "Retention and data loss prevention",
  "sharepoint-site-settings": "SharePoint site settings",
  "sharepoint-structure": "SharePoint site structure",
  "sharepoint-sites": "SharePoint sites",
  "onedrive-site-settings": "OneDrive settings",
  onedrive: "OneDrive files",
  "power-platform-settings": "Power Platform settings",
  planner: "Planner plans",
};

export function workloadLabel(workload: string): string {
  return WORKLOAD_LABELS[workload] ?? workload.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}

const OUTCOME_WORDS: Record<string, string> = {
  complete: "read in full",
  "complete-empty": "read in full",
  partial: "read in part",
  failed: "failed to read",
  disabled: "not switched on",
  "not-requested": "not read",
  unavailable: "not available on this tenant",
  unknown: "read",
};

export function outcomeWords(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? "not read";
}

export function notComparedSentence(entry: { left: string; right: string }): string {
  return `First side ${outcomeWords(entry.left)}, second side ${outcomeWords(entry.right)}.`;
}

export function workloadNotComparedSentence(group: WorkloadGroup): string {
  if (group.reason === "not-collected") return !group.left ? "Not collected for the first side." : "Not collected for the second side.";
  return "A collection on one side failed or is switched off, so nothing is compared.";
}

const CONTAINER_KINDS: [RegExp, string][] = [
  [/^mailbox\//, "Mailbox"],
  [/^archive\//, "Archive mailbox"],
  [/^group\//, "Group mailbox"],
  [/^drive:/, "Drive"],
  [/^site:/, "Site"],
  [/^team:/, "Team"],
  [/^plan:/, "Plan"],
];

/** Which part of a container, then its kind ("Inbox (mailbox)"); the raw name stays in the record. */
export function containerWords(container: string): string {
  const kind = CONTAINER_KINDS.find(([pattern]) => pattern.test(container))?.[1] ?? "Container";
  const parts = container.split("/").slice(2).filter((part) => part && part !== "items" && !/^[0-9a-f-]{16,}$/i.test(part) && !part.includes(":"));
  if (!parts.length) return kind;
  const name = parts.join(" › ");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${kind.toLowerCase()})`;
}

export function contentItemWords(item: ContentItem): string {
  if (item.name) return item.name;
  return item.kind ? `An item (${item.kind.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").toLowerCase()})` : "An item";
}

/** A value in words: a reference reads as the object's name, an id as the name Keel has for it. */
export function compareValueWords(value: unknown, names: Readonly<Record<string, string>> = {}): string {
  return valueWords(readableValue(value, names));
}

export function rawValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "absent" : text;
}

export function countsWords(counts: { added?: number; removed?: number; changed?: number }): string {
  const parts = (["changed", "added", "removed"] as const)
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `${(counts[key] ?? 0).toLocaleString("en-GB")} ${key}`);
  return parts.length ? parts.join(", ") : "no differences";
}

export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// Why a kind was left out of a comparison, worded for a person: one short phrase per
// read outcome, so many kinds fold into a few reasons instead of one sentence each.
const GAP_WORDS: Record<string, string> = {
  partial: "Read only in part",
  failed: "Could not be read",
  disabled: "Switched off",
  "not-requested": "Not in that backup",
  unavailable: "Not available on that tenant",
};
const FULL_READS = new Set(["complete", "complete-empty", "unknown"]);
// Problems first: a failed read before a partial one before a kind that was never asked for.
const GAP_ORDER = ["failed", "partial", "unavailable", "disabled", "not-requested"];

export type GapTone = "failed" | "partial" | "neutral";

export interface NotComparedReason<T> {
  key: string;
  /** "Could not be read" */
  reason: string;
  /** Which side fell short: "before", "after" or "both". */
  side: "before" | "after" | "both";
  tone: GapTone;
  entries: T[];
}

const gapWords = (outcome: string) => GAP_WORDS[outcome] ?? "Not read";
const gapRank = (outcome: string) => { const rank = GAP_ORDER.indexOf(outcome); return rank < 0 ? GAP_ORDER.length : rank; };

/** Kinds left out of a comparison, grouped by why (and which side), worst first, then
 * by how many kinds share the reason. */
export function notComparedReasons<T extends { left: string; right: string }>(entries: readonly T[]): NotComparedReason<T>[] {
  const groups = new Map<string, NotComparedReason<T> & { rank: number }>();
  for (const entry of entries) {
    const leftGap = !FULL_READS.has(entry.left);
    const rightGap = !FULL_READS.has(entry.right);
    const side = leftGap && rightGap ? "both" : leftGap ? "before" : "after";
    const outcomes = side === "both" ? [entry.left, entry.right] : [side === "before" ? entry.left : entry.right];
    const unique = [...new Set(outcomes)];
    const worst = unique.reduce((best, outcome) => (gapRank(outcome) < gapRank(best) ? outcome : best));
    const key = `${side}:${unique.join("/")}`;
    const group = groups.get(key) ?? {
      key,
      reason: unique.map(gapWords).join(" / "),
      side,
      tone: worst === "failed" ? "failed" : worst === "partial" ? "partial" : "neutral",
      rank: gapRank(worst),
      entries: [] as T[],
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || b.entries.length - a.entries.length || a.reason.localeCompare(b.reason))
    .map(({ rank: _rank, ...group }) => group);
}

/** One changed item the Compare page can open in its details panel. Plain data, so the
 *  page (a server component) can hand the list to the panel (a client component). */
export interface CompareOpenable {
  id: string;
  name: string;
  kind: string;
  service: string;
  fields: CompareField[];
  fieldsTotal?: number;
}

/** The address key of a changed item on Compare (`?item=`). */
export function compareItemId(resourceType: string, naturalKey: string): string {
  return `${resourceType}|${naturalKey}`;
}

/** A changed item in one line: how many settings differ and the first few by name. */
export function compareItemLine(fields: readonly { path: string }[], total?: number): string {
  const count = Math.max(total ?? 0, fields.length);
  if (!count) return "Only settings Microsoft sets itself differ.";
  const names = [...new Set(fields.map((field) => fieldWords(field.path)))];
  const first = names.slice(0, 2);
  if (!first.length) return `${count === 1 ? "1 setting differs" : `${count.toLocaleString("en-GB")} settings differ`}.`;
  const rest = count - first.length;
  const list = rest > 0 ? `${first.join(", ")} and ${rest} more` : first.length === 2 ? `${first[0]} and ${first[1]}` : first[0];
  return `${count === 1 ? "1 setting differs" : `${count.toLocaleString("en-GB")} settings differ`}: ${list}.`;
}
