import type { IconName } from "@/components/shell/icons";
import { plainKind, typeService } from "@/lib/baselines-view";
import { changeName } from "@/lib/changes-view";
import type { RiskTone } from "@/lib/menu-status";
import { ago, formatTimestamp } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { type EngineRef, personLabel } from "@/lib/sentences";
import { type CloudService, serviceFor } from "@/lib/services";
import type {
  BaselineCapture,
  BaselineChanges,
  BaselineRecord,
  ComplianceData,
  ComplianceFinding,
  ComplianceFixCandidate,
  ComplianceSummary,
  KnownStandard,
  OwnCheck,
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

/** The kinds a baseline left out because Microsoft kept failing to answer, in words; null when none. */
export function leftOutWords(capture: BaselineCapture | undefined): string | null {
  const names = [...new Set((capture?.leftOut ?? []).map((item) => plainKind(item.type)))].sort();
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "is" : "are"} not in this setup: Microsoft kept answering with an error when its backup was taken, so changes to ${names.length === 1 ? "it" : "them"} are not checked. Capture a new version once Microsoft answers again.`;
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
  // The service a control is filed under, when it is not its kind's own service: the
  // mail protection policies are read through Exchange but managed in Defender.
  service?: string;
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
    what: "Looks for a sign-in rule that is on and blocks old sign-in methods for every user and every app.",
    why: "Old sign-in methods skip multi-factor sign-in, so a stolen password is enough.",
    types: ["conditionalAccessPolicy"],
  },
  // Defender email protection, read from the Exchange mail protection policies.
  "keel-custom.defender-email.anti-phish-spoof-protection": {
    title: "Anti-phishing catches senders pretending to be someone else",
    short: "Spoofed senders caught",
    what: "Checks every anti-phishing policy that is on: spoof protection on, the sender domain's own anti-spoofing rule (DMARC) followed, and a question mark shown on senders that cannot be verified.",
    why: "Without it, mail that pretends to come from your boss or a supplier lands in the inbox looking real.",
    types: ["exchange-mail-flow"],
    service: "Defender",
  },
  "keel-custom.defender-email.anti-spam-phish-quarantined": {
    title: "Phishing mail goes to quarantine",
    short: "Phishing quarantined",
    what: "Checks every anti-spam policy: phishing and high-confidence phishing go to quarantine, and phishing already delivered is pulled back out of mailboxes.",
    why: "Phishing left in the Junk folder is still one click away from a stolen password.",
    types: ["exchange-mail-flow"],
    service: "Defender",
  },
  "keel-custom.defender-email.anti-spam-no-allowed-domains": {
    title: "No whole domain skips spam filtering",
    short: "No domain skips filtering",
    what: "Checks every anti-spam policy for allowed sender domains, whose mail skips spam filtering.",
    why: "Anyone can fake a sender from an allowed domain, so its phishing skips the filter too.",
    types: ["exchange-mail-flow"],
    service: "Defender",
  },
  "keel-custom.defender-email.malware-file-filter": {
    title: "Risky attachment types are blocked",
    short: "Risky attachments blocked",
    what: "Checks every malware policy: risky file types (such as .exe) are blocked, and malware already delivered is pulled back out of mailboxes.",
    why: "Attachments are still the most common way malware gets in.",
    types: ["exchange-mail-flow"],
    service: "Defender",
  },
  "keel-custom.defender-email.safe-links-email": {
    title: "Links in email are checked when clicked",
    short: "Email links checked",
    what: "Checks every Safe Links policy: links in email are checked when clicked, and nobody can click past the warning to a dangerous site.",
    why: "A link that was safe when the mail arrived can turn malicious hours later.",
    types: ["exchange-mail-flow"],
    service: "Defender",
  },
};

// The settings a control can name in its detail lines, in plain words.
const SETTING_WORDS: Record<string, string> = {
  EnableSpoofIntelligence: "Spoof protection",
  HonorDmarcPolicy: "Follows the sender domain's DMARC rule",
  EnableUnauthenticatedSender: "Question mark on unverified senders",
  PhishSpamAction: "Phishing goes to",
  HighConfidencePhishAction: "High-confidence phishing goes to",
  PhishZapEnabled: "Pulls back delivered phishing",
  AllowedSenderDomains: "Allowed sender domains",
  EnableFileFilter: "Blocks risky file types",
  ZapEnabled: "Pulls back delivered malware",
  EnableSafeLinksForEmail: "Checks links in email",
  ScanUrls: "Checks links when clicked",
  AllowClickThrough: "Lets people click past the warning",
  // Entra ID controls.
  assignmentCount: "People who hold it",
  includeUnknownCountriesAndRegions: "Takes in unknown countries",
  onPremisesSyncEnabled: "Copied from on-premises",
};

// Words that only fit one control's lines. Names such as "state" or "includeUsers" are
// common, so their words here must not reach another control that uses the same name.
const CONTROL_SETTING_WORDS: Record<string, Record<string, string>> = {
  // The legacy sign-in control, one line per sign-in rule that blocks old clients.
  "keel-custom.conditional-access.block-legacy": {
    state: "Status",
    includeUsers: "Users it covers",
    includeApplications: "Apps it covers",
    clientAppTypes: "Old sign-in methods it blocks",
  },
};

// Values that read better in words, by control and then setting.
const CONTROL_VALUE_WORDS: Record<string, Record<string, Record<string, string>>> = {
  "keel-custom.conditional-access.block-legacy": {
    state: { enabled: "On", disabled: "Off", enabledforreportingbutnotenforced: "Report-only" },
    includeUsers: { all: "All users", "only some": "Only some users", none: "No users" },
    includeApplications: { all: "All apps", "only some": "Only some apps", none: "No apps" },
    clientAppTypes: { exchangeactivesync: "Exchange ActiveSync", other: "Other old clients" },
  },
};

/** A setting's name in plain words, using the control's own words first. */
export function settingWords(setting: string, controlId?: string): string {
  return (controlId ? CONTROL_SETTING_WORDS[controlId]?.[setting] : undefined) ?? SETTING_WORDS[setting] ?? setting;
}

// Settings that read better as a yes or no than as on or off.
const YES_NO_SETTINGS = new Set(["includeUnknownCountriesAndRegions", "onPremisesSyncEnabled"]);

// Exchange's action codes in plain words.
const ACTION_WORDS: Record<string, string> = {
  quarantine: "Quarantine",
  movetojmf: "Junk folder",
  addxheader: "Inbox, with a header added",
  modifysubject: "Inbox, with the subject changed",
  redirect: "Another address",
  delete: "Deleted",
  noaction: "Inbox",
};

/** A setting's value in plain words: On / Off, an action, a list, a limit, or "None". */
export function settingValueWords(value: unknown, setting?: string, controlId?: string): string {
  if (typeof value === "boolean" && setting && YES_NO_SETTINGS.has(setting)) return value ? "Yes" : "No";
  const words = setting && controlId ? CONTROL_VALUE_WORDS[controlId]?.[setting] : undefined;
  if (words && typeof value === "string") return words[value.toLowerCase()] ?? value;
  if (words && Array.isArray(value) && value.length) return value.map((item) => words[String(item).toLowerCase()] ?? String(item)).join(", ");
  if (value === true) return "On";
  if (value === false) return "Off";
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(", ") : "None";
  if (typeof value === "string") return ACTION_WORDS[value.toLowerCase()] ?? value;
  if (typeof value === "number") return value.toLocaleString("en-GB");
  if (typeof value === "object" && typeof (value as { atMost?: unknown }).atMost === "number") {
    return `${(value as { atMost: number }).atMost.toLocaleString("en-GB")} or fewer`;
  }
  return String(value);
}

export interface ControlCheck { subject: string; setting: string; now: string; shouldBe: string; ok: boolean }

/** The engine keeps at most this many lines per result, failing ones first (MAX_DETAILS). */
export const CHECK_LINE_LIMIT = 50;

/** Whether the stored lines may be cut short, so counts are "at least", never exact. */
export function checksCapped(checks: ControlCheck[]): boolean {
  return checks.length >= CHECK_LINE_LIMIT;
}

/**
 * Every setting the control checked, current against expected, in plain words. Failing
 * lines come first; otherwise the engine's order (object by object) is kept.
 */
export function controlChecks(finding: ComplianceFinding): ControlCheck[] {
  const lines = (finding.details ?? []).map((line) => ({
    subject: line.subject,
    setting: settingWords(line.setting, finding.controlId),
    now: settingValueWords(line.value, line.setting, finding.controlId),
    shouldBe: settingValueWords(line.expected, line.setting, finding.controlId),
    ok: line.ok === true,
  }));
  return [...lines.filter((line) => !line.ok), ...lines.filter((line) => line.ok)];
}

// `exact` is true when the result stored its counts; without them, a list of 50 lines may
// have been cut short and its counts are only "at least".
export interface CheckCounts { checked: number; failing: number; passing: number; listed: number; exact: boolean }

/**
 * How many settings the control checked, failed and met, counted over everything it
 * checked rather than the lines kept (at most 50). Results stored before the counts
 * existed fall back to their lines. `listed` is how many lines the panel can show.
 */
export function checkCounts(finding: ComplianceFinding): CheckCounts {
  const lines = finding.details ?? [];
  const listedFailing = lines.filter((line) => line.ok !== true).length;
  const stored = finding.detailCounts;
  const checked = Math.max(stored?.checked ?? 0, lines.length);
  const failing = Math.min(checked, Math.max(stored?.failing ?? 0, listedFailing));
  return { checked, failing, passing: checked - failing, listed: lines.length, exact: Boolean(stored) };
}

/**
 * Whether the failing count of a result is only "at least": stored before the counts
 * existed, with a full list of 50 lines that all fail, so more may have failed.
 */
export function failingMore(counts: CheckCounts): boolean {
  return !counts.exact && counts.listed >= CHECK_LINE_LIMIT && counts.failing === counts.listed;
}

/** The control sheet's red badge: how many settings fail, "or more" when only at least. */
export function failingBadge(counts: CheckCounts): string {
  if (counts.failing === 1) return "1 setting";
  return `${counts.failing.toLocaleString("en-GB")}${failingMore(counts) ? " or more" : ""} settings`;
}

/**
 * The totals the "Technical details" record shows beside the kept lines: how many
 * settings were checked and failed, and how many lines are listed when the list is cut.
 * A result stored before the counts existed with a full list of 50 lines says "or more".
 * null when the control listed no settings.
 */
export function checkCountRecord(finding: ComplianceFinding): { checked: string; failing: string; listed: string | null } | null {
  const counts = checkCounts(finding);
  if (!counts.checked) return null;
  const capped = !counts.exact && counts.listed >= CHECK_LINE_LIMIT;
  const words = (value: number, more: boolean) => `${value.toLocaleString("en-GB")}${more ? " or more" : ""}`;
  return {
    checked: words(counts.checked, capped),
    failing: words(counts.failing, failingMore(counts)),
    listed: counts.listed < counts.checked || capped
      ? `First ${counts.listed.toLocaleString("en-GB")}${counts.failing ? ", failing ones first" : ""}`
      : null,
  };
}

/** What made a control fail, one line per object and setting, in plain words. */
export function controlMisses(finding: ComplianceFinding): ControlCheck[] {
  return controlChecks(finding).filter((line) => !line.ok);
}

// What the first column of the checked-settings table names, by the kind a control reads.
const SUBJECT_WORDS: Record<string, string> = {
  "exchange-mail-flow": "Policy",
  roleAssignment: "Role",
  namedLocation: "Location",
  group: "Group",
  conditionalAccessPolicy: "Sign-in rule",
};

/** The heading of the checked-settings table's first column: Policy, Group, Location... */
export function checkSubjectWord(finding: ComplianceFinding): string {
  const type = CONTROL_WORDS[finding.controlId]?.types[0] ?? finding.evidence[0]?.resourceType;
  return (type && SUBJECT_WORDS[type]) ?? "Item";
}

const CHECK_WORDS: Record<string, string> = {
  roleAssignment: "admin role assignments",
  namedLocation: "trusted locations",
  group: "groups",
  conditionalAccessPolicy: "sign-in rules",
  "exchange-mail-flow": "mail protection policies",
};

// One backup of a kind, where dropping the plural "s" does not read ("mail protection policie").
const ONE_WORDS: Record<string, string> = {
  "exchange-mail-flow": "mail protection",
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
  if (finding.own) return [finding.own.resourceType];
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
  if (finding.own) return ownCheckSentence(finding.own);
  return CONTROL_WORDS[finding.controlId]?.what ?? `Checks ${findingTypes(finding)}.`;
}

/** "Every one of the sign-in rules has State set to On." Said for a check the tenant wrote. */
export function ownCheckSentence(check: Pick<OwnCheck, "resourceType" | "field" | "operator" | "expected" | "appliesTo">): string {
  const who = check.appliesTo === "any" ? `At least one of the ${kindWords(check.resourceType)}` : `Every one of the ${kindWords(check.resourceType)}`;
  const how = check.operator === "not-equals" ? "set to anything but" : "set to";
  return `${who} has ${check.field} ${how} ${settingValueWords(check.expected)}.`;
}

export function controlWhy(finding: ComplianceFinding): string | null {
  return CONTROL_WORDS[finding.controlId]?.why ?? null;
}

// The service each CISA ScubaGear product's rules are filed under. A rule Keel cannot
// check has no evidence to take a service from, so it is placed by its product.
const SCUBA_PRODUCT_SERVICES: Record<string, string> = {
  aad: "Entra",
  exo: "Exchange",
  securitysuite: "Defender",
  sharepoint: "SharePoint",
  teams: "Teams",
  powerplatform: "Power Platform",
  powerbi: "Power Platform",
};
export const SCUBA_FRAMEWORK = "cisa-scuba";

export function controlService(finding: ComplianceFinding): CloudService {
  const own = CONTROL_WORDS[finding.controlId]?.service ?? (finding.framework === SCUBA_FRAMEWORK ? SCUBA_PRODUCT_SERVICES[finding.profile] : undefined);
  return own ? serviceFor(own) : typeService(controlTypes(finding)[0] ?? "other");
}

const STANDARD_WORDS: Record<string, string> = {
  "keel-custom": "Keel checks",
  "cisa-scuba": "CISA SCuBA",
  "nist-800-53": "NIST SP 800-53",
};

export function standardName(finding: ComplianceFinding): string {
  // A check the tenant wrote is filed under the standard it was written for.
  if (finding.framework === OWN_FRAMEWORK) return finding.own?.standard ?? finding.profile ?? OWN_DEFAULT_STANDARD;
  return STANDARD_WORDS[finding.framework] ?? finding.framework.replace(/[-_]/g, " ").toUpperCase();
}

export const OWN_FRAMEWORK = "own";
export const OWN_DEFAULT_STANDARD = "Our standard";

/** The names of the tenant's own standards, from the checks written for them. */
export function ownStandards(findings: ComplianceFinding[]): string[] {
  return [...new Set(findings.filter((finding) => finding.own).map((finding) => finding.own!.standard))].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------ known standards -- */

export type CoverageResult = ControlResult | "not-checked";

export interface CoverageRow {
  ref: string;
  area: string;
  areaName: string | null;
  result: CoverageResult;
  mapped: { controlId: string; match: "full" | "partial"; note: string | null; finding: ComplianceFinding | null }[];
}

export interface Coverage {
  rows: CoverageRow[];
  total: number;
  checked: number;
  passing: number;
  // Policies whose only checks cover part of them, and those pass: never a full pass.
  partlyPassing: number;
  notPassing: number;
  unknown: number;
}

/**
 * How a known standard's policies stand on this tenant: each policy takes the worst
 * result of the checks mapped to it. A policy no check maps to is "not checked"; one
 * whose checks have no result yet is "could not check". Never a pass by default.
 */
export function standardCoverage(standard: KnownStandard, findings: ComplianceFinding[]): Coverage {
  const byControl = new Map(findings.map((finding) => [finding.controlId, finding]));
  const rows = standard.refs.map((entry): CoverageRow => {
    const mapped = entry.controls.map((control) => ({ ...control, finding: byControl.get(control.controlId) ?? null }));
    let result: CoverageResult = "not-checked";
    if (mapped.length) {
      const results = mapped.map((item) => (item.finding ? resultOf(item.finding) : "unknown" as ControlResult));
      result = results.sort((left, right) => RESULTS[left].rank - RESULTS[right].rank)[0];
    }
    return { ref: entry.ref, area: entry.area, areaName: entry.areaName, result, mapped };
  });
  const checked = rows.filter((row) => row.result !== "not-checked");
  return {
    rows,
    total: rows.length,
    checked: checked.length,
    passing: checked.filter((row) => (row.result === "passing" || row.result === "not-relevant") && !partOnly(row)).length,
    partlyPassing: checked.filter((row) => (row.result === "passing" || row.result === "not-relevant") && partOnly(row)).length,
    notPassing: checked.filter((row) => row.result === "failing" || row.result === "not-set-up" || row.result === "excepted").length,
    unknown: checked.filter((row) => row.result === "unknown").length,
  };
}

function partOnly(row: CoverageRow): boolean {
  return row.mapped.every((item) => item.match === "partial");
}

/** "Keel checks 3 of 43 CISA SCuBA policies: 1 passes, 2 do not." */
export function coverageSentence(standard: KnownStandard, coverage: Coverage): string {
  const scope = standard.complete
    ? `Keel checks ${coverage.checked} of ${plural(coverage.total, `${standard.name} policy`, `${standard.name} policies`)}`
    : `Keel maps ${plural(coverage.checked, `${standard.name} control`)}`;
  const parts = [
    coverage.passing ? `${coverage.passing} ${coverage.passing === 1 ? "passes" : "pass"}` : null,
    coverage.partlyPassing ? `${coverage.partlyPassing} ${coverage.partlyPassing === 1 ? "passes" : "pass"} in part` : null,
    coverage.notPassing ? `${coverage.notPassing} ${coverage.notPassing === 1 ? "does not" : "do not"}` : null,
    coverage.unknown ? `${coverage.unknown} could not be checked` : null,
  ].filter(Boolean);
  return parts.length ? `${scope}: ${parts.join(", ")}.` : `${scope}.`;
}

export const COVERAGE_WORDS: Record<"full" | "partial", string> = { full: "Checks this", partial: "Checks part of this" };

export const KNOWN_STANDARDS_NOTE = "Meeting a standard here is not a certification. CIS Benchmarks are not included: their licence does not allow Keel to ship them.";

/** A known standard's checked policies, worst first in the order of RESULTS (fails, not
 * set up yet, could not check, accepted, passes, not relevant), and in the standard's own
 * order within each result. */
export function orderCoverageRows(rows: CoverageRow[]): CoverageRow[] {
  const rank = (row: CoverageRow) => (row.result === "not-checked" ? 99 : RESULTS[row.result].rank);
  return rows.map((row, index) => ({ row, index })).sort((left, right) => rank(left.row) - rank(right.row) || left.index - right.index).map((entry) => entry.row);
}

/** Why a checked policy has no pass or fail, in plain words: the reason of its first
 * check that could not be run, or that the check has not run yet. */
export function coverageReason(row: CoverageRow): string | null {
  if (row.result !== "unknown") return null;
  const stuck = row.mapped.find((item) => !item.finding || resultOf(item.finding) === "unknown");
  if (!stuck) return null;
  return stuck.finding ? reasonWords(stuck.finding) : "It runs after the next backup.";
}

// The four states a control can be in (Fails, Not set up yet, Passes, Accepted exception),
// plus two that say Keel could not judge it: no usable backup, or nothing to check here.
export type ControlResult = "failing" | "not-set-up" | "unknown" | "excepted" | "passing" | "not-relevant";

export const RESULTS: Record<ControlResult, { label: string; plural: string; tone: RiskTone | null; badge: "urgent" | "soon" | "fine" | "neutral"; icon: IconName; rank: number }> = {
  failing: { label: "Fails", plural: "Fails", tone: "urgent", badge: "urgent", icon: "x-circle", rank: 0 },
  "not-set-up": { label: "Not set up yet", plural: "Not set up yet", tone: "soon", badge: "soon", icon: "plus", rank: 1 },
  unknown: { label: "Could not check", plural: "Could not be checked", tone: "soon", badge: "soon", icon: "info", rank: 2 },
  excepted: { label: "Accepted exception", plural: "Accepted exceptions", tone: null, badge: "neutral", icon: "pause", rank: 3 },
  passing: { label: "Passes", plural: "Passes", tone: "fine", badge: "fine", icon: "check-circle", rank: 4 },
  "not-relevant": { label: "Not relevant here", plural: "Not relevant here", tone: null, badge: "neutral", icon: "hide", rank: 5 },
};

export function isResult(value: string | null): value is ControlResult {
  return value !== null && value in RESULTS;
}

/** What "Not set up yet" means, said on the control's panel. */
export const NOT_SET_UP_HELP = "The setting this control looks for does not exist in Microsoft 365 yet. It counts as not passing. Set it up there, and Keel checks again after the next backup.";

/** The engine's reason when a control fails because the setting does not exist at all. */
export const NOT_CONFIGURED = "not-configured";

/** A fail hides only behind an exception in force; an ended or incomplete one leaves it
 * failing. A fail because the setting does not exist yet reads "Not set up yet". */
export function resultOf(finding: ComplianceFinding): ControlResult {
  if (finding.verdict === "fail") {
    if (!finding.exposed) return "excepted";
    return finding.reason === NOT_CONFIGURED ? "not-set-up" : "failing";
  }
  if (finding.verdict === "unknown") return "unknown";
  if (finding.verdict === "pass") return "passing";
  return "not-relevant";
}

export function findingStatus(finding: ComplianceFinding): string {
  return RESULTS[resultOf(finding)].label;
}

export type ComplianceCounts = Record<ControlResult, number> & { total: number; ended: number };

export function complianceCounts(findings: ComplianceFinding[]): ComplianceCounts {
  const counts: ComplianceCounts = { failing: 0, "not-set-up": 0, excepted: 0, unknown: 0, passing: 0, "not-relevant": 0, total: findings.length, ended: 0 };
  for (const finding of findings) {
    counts[resultOf(finding)] += 1;
    if (finding.exposed && finding.exceptionState === "expired") counts.ended += 1;
  }
  return counts;
}

export function countsFromSummary(summary: ComplianceSummary): ComplianceCounts {
  return {
    failing: summary.exposed - (summary.notConfigured ?? 0), "not-set-up": summary.notConfigured ?? 0, excepted: summary.excepted, unknown: summary.unknown, passing: summary.passing,
    "not-relevant": summary.notApplicable, total: summary.controls, ended: summary.expiredExceptions,
  };
}

/** The header's status pill. */
export function complianceStatus(counts: ComplianceCounts): { tone: RiskTone; label: string } {
  if (counts.total === 0) return { tone: "low", label: "Not checked yet" };
  if (counts.failing) return { tone: "urgent", label: `${counts.failing} failing` };
  if (counts["not-set-up"]) return { tone: "soon", label: `${counts["not-set-up"]} not set up yet` };
  if (counts.unknown) return { tone: "soon", label: `${counts.unknown} could not be checked` };
  return { tone: "fine", label: "All pass" };
}

export interface ComplianceVerdict { text: string; detail?: string; tone: "urgent" | "soon" | "fine" | "neutral" }

export function complianceVerdict(data: ComplianceData): ComplianceVerdict {
  const counts = complianceCounts(data.findings);
  const now = data.generatedAt;
  if (counts.total === 0) return { text: "No control has been checked on this tenant yet.", detail: NOT_CHECKED_YET, tone: "neutral" };
  const notSetUp = counts["not-set-up"]
    ? `; ${plural(counts["not-set-up"], "control is", "controls are")} not set up yet`
    : "";
  if (counts.failing === 1) {
    const finding = data.findings.find((entry) => resultOf(entry) === "failing")!;
    const text = finding.exceptionState === "expired"
      ? `1 control fails, and its exception ended ${ago(finding.exception?.expiresAt ?? null, now)}${notSetUp}.`
      : finding.exceptionState === "incomplete"
        ? `1 control fails; its exception has no owner or end date, so it does not count${notSetUp}.`
        : `1 control fails, with no exception${notSetUp}.`;
    const fixable = fixCandidates(finding).length > 0;
    return { text, detail: `${controlName(finding)}: ${fixable ? "let Keel fix it after an approval" : "fix it in Microsoft 365"}, or accept it for a while with an exception.`, tone: "urgent" };
  }
  if (counts.failing > 1) {
    const ended = counts.ended ? `; ${counts.ended === 1 ? "one exception has" : `${counts.ended} exceptions have`} ended` : "";
    return { text: `${plural(counts.failing, "control fails", "controls fail")}${ended}${notSetUp}.`, detail: "Open each one to see what it rests on, then fix it or accept it with an exception.", tone: "urgent" };
  }
  if (counts["not-set-up"] === 1) {
    const finding = data.findings.find((entry) => resultOf(entry) === "not-set-up")!;
    return { text: "No control fails, but 1 is not set up yet.", detail: `${controlName(finding)}: the setting it looks for does not exist in Microsoft 365 yet.`, tone: "soon" };
  }
  if (counts["not-set-up"] > 1) {
    return { text: `No control fails, but ${counts["not-set-up"]} are not set up yet.`, detail: "The settings they look for do not exist in Microsoft 365 yet. Open each one to see what to set up.", tone: "soon" };
  }
  if (counts.unknown) {
    return { text: `No control fails; ${plural(counts.unknown, "control")} could not be checked.`, detail: "The backup each one needs is missing or too old.", tone: "soon" };
  }
  return { text: `All ${plural(counts.total, "checked control")} pass or have a current exception.`, tone: "fine" };
}

/** Why a control could not be checked, from the engine's reason code ("group:stale-observation"). */
export function reasonWords(finding: ComplianceFinding): string {
  const reason = finding.reason ?? "";
  if (reason.startsWith("scubagear:")) return scubaReasonWords(reason.slice("scubagear:".length));
  const split = reason.indexOf(":");
  const type = split > 0 ? reason.slice(0, split) : controlTypes(finding)[0] ?? null;
  const code = split > 0 ? reason.slice(split + 1) : reason;
  const kind = type ? kindWords(type) : "settings";
  const one = (type ? ONE_WORDS[type] : undefined) ?? kind.replace(/s$/, "");
  if (code === "no-observation") return `No backup of ${kind} has been made yet.`;
  if (code === "stale" || code === "stale-observation") return `The newest ${one} backup is too old for this check.`;
  if (code.startsWith("observation-")) return `The newest ${one} backup did not finish.`;
  if (code) return `The ${one} backup it needs cannot be used.`;
  return "Keel could not check it.";
}

/** Why a CISA ScubaGear rule could not be checked, in plain words. */
function scubaReasonWords(code: string): string {
  if (code === "check-by-hand") return "CISA lists this as a check to do by hand.";
  if (code.startsWith("not-read:")) return "Keel does not back up the settings this rule reads yet.";
  if (code.startsWith("field-not-read:")) return "A setting this rule reads is not in Keel's backup yet.";
  if (code.startsWith("incomplete:")) return "The backup cannot answer what this rule asks.";
  if (code.startsWith("needs-setting:")) return "This rule needs a list only you can give, such as your sensitive users or partner domains, and Keel cannot take it yet.";
  return "Keel could not run this rule.";
}

/** The second line of a row and of a phone tile: the result in a few words. */
export function resultLine(finding: ComplianceFinding, now: string): string {
  switch (resultOf(finding)) {
    case "not-set-up":
    case "failing":
      if (finding.exceptionState === "expired") return `Exception ended ${ago(finding.exception?.expiresAt ?? null, now)}`;
      if (finding.exceptionState === "incomplete") return "Exception has no owner or end date";
      return resultOf(finding) === "not-set-up" ? "The setting does not exist yet" : "No exception";
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

/** Worst first: fails, not set up yet, could not check, accepted, passes; then by name. */
export function orderFindings(findings: ComplianceFinding[]): ComplianceFinding[] {
  return [...findings].sort((left, right) => RESULTS[resultOf(left)].rank - RESULTS[resultOf(right)].rank || controlName(left).localeCompare(controlName(right)));
}

/* --------------------------------------------------------------- exceptions -- */

/** The owner as a person: by name when they are in Keel, else the name an address reads as. */
export function ownerPerson(finding: ComplianceFinding): EngineRef | null {
  const exception = finding.exception;
  if (!exception?.owner && !exception?.ownerRef) return null;
  if (exception.ownerRef) return { kind: "person", id: exception.ownerRef.id, name: exception.ownerRef.name, readable: true, email: exception.owner ?? undefined, pseudonym: exception.ownerRef.pseudonym } as EngineRef;
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

/* ------------------------------------------------------------ make it pass -- */

// CoreView gap 6: a failing control that declares a fix offers "Make it pass" for each
// object it fails on. Keel plans one setting against the live tenant; nothing changes
// until someone else approves it, and the write can be undone like any restore.

interface FixWords {
  // The button and the panel heading.
  action: string;
  // The setting's plain name, as the row's "Setting" column shows it.
  setting: string;
  // What changes for people once it is fixed.
  effect: string;
}

const FIX_WORDS: Record<string, FixWords> = {
  "keel-custom.named-location.no-untrusted-all-countries": {
    action: "Stop trusting unknown countries",
    setting: "Takes in unknown countries",
    effect: "The location stays trusted for the countries it lists. Sign-ins from places that cannot be told no longer count as trusted.",
  },
  // The Defender email checks: one setting of one policy per row, named by the row.
  "keel-custom.defender-email.anti-phish-spoof-protection": {
    action: "Turn on spoof protection",
    setting: "",
    effect: "Mail that pretends to come from someone else is flagged, and may go to junk or quarantine. An approver also reviews that, because quarantined mail is deleted after a while.",
  },
  "keel-custom.defender-email.anti-spam-phish-quarantined": {
    action: "Quarantine phishing",
    setting: "",
    effect: "Phishing goes to quarantine instead of the inbox or junk folder, and is pulled back after delivery. An approver also reviews that, because quarantined mail is deleted after a while.",
  },
  "keel-custom.defender-email.anti-spam-no-allowed-domains": {
    action: "Remove allowed sender domains",
    setting: "",
    effect: "Mail from these domains is filtered like any other mail again, so some of it may go to junk or quarantine. An approver also reviews that.",
  },
  "keel-custom.defender-email.malware-file-filter": {
    action: "Block risky attachments",
    setting: "",
    effect: "Mail with risky attachment types is blocked, and malware already delivered is pulled back. An approver also reviews that, because blocked mail does not reach the inbox.",
  },
  "keel-custom.defender-email.safe-links-email": {
    action: "Check links in email",
    setting: "",
    effect: "Links in email are checked when clicked, and people can no longer click past the warning to a dangerous site.",
  },
};

/** The objects Keel can fix for this control: only while it fails and has a fix. */
export function fixCandidates(finding: ComplianceFinding): ComplianceFixCandidate[] {
  if (finding.verdict !== "fail" || !finding.fix) return [];
  return finding.fixCandidates ?? [];
}

/** Who may ask for the fix: someone with the restore permission, on a control Keel can fix. */
export function canFixOn(finding: ComplianceFinding, canRestore: boolean): boolean {
  return canRestore && fixCandidates(finding).length > 0;
}

export function fixAction(finding: ComplianceFinding): string {
  return FIX_WORDS[finding.controlId]?.action ?? "Make it pass";
}

/** The setting a row changes in plain words: the row's own setting when the fix has several. */
export function fixSetting(finding: ComplianceFinding, candidate?: ComplianceFixCandidate): string {
  const field = candidate?.field ?? finding.fix?.field ?? "";
  if (SETTING_WORDS[field]) return SETTING_WORDS[field];
  return FIX_WORDS[finding.controlId]?.setting || (field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase()) || "The setting");
}

export function fixEffect(finding: ComplianceFinding): string | null {
  return FIX_WORDS[finding.controlId]?.effect ?? null;
}

// Settings that hold a list: the fix empties them by writing "not set".
const LIST_SETTINGS = new Set(["AllowedSenderDomains"]);

/** A setting's value in words: Yes, No, Not set, or the value itself. A mail protection setting reads as its check shows it. */
export function fixValue(value: unknown, field?: string): string {
  if (field && SETTING_WORDS[field]) return settingValueWords(value === null && LIST_SETTINGS.has(field) ? [] : value, field);
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "Not set";
  return String(value);
}

/** The object by its own name; its kind when it has none (never its key or id). */
export function fixObjectName(candidate: ComplianceFixCandidate): string {
  return candidate.name ?? `A ${kindWords(candidate.resourceType).replace(/s$/, "")} with no name`;
}

/** "1 location can be fixed by Keel" for the row and the verdict. */
export function fixableSentence(finding: ComplianceFinding): string | null {
  const count = fixCandidates(finding).length;
  if (count === 0) return null;
  return `Keel can fix ${count === 1 ? "it" : `all ${count}`} for you, after an approval.`;
}

export const FIX_STEPS = "Keel first plans the change against the live tenant and shows it here. Nothing changes until someone else approves it, and it can be undone like any restore.";

export function fixRefusal(status: number, error: string | undefined): string {
  if (status === 403) return "You need the restore permission to fix a control.";
  if (status === 404) return "Keel no longer holds this result. Reload the page.";
  if (error === "not_failing") return "This control passes now, so there is nothing to fix.";
  if (error === "not_newest") return "A newer check of this control exists. Reload the page.";
  if (error === "no_fix") return "Keel has no fix for this control. Fix it in Microsoft 365 or grant an exception.";
  if (error === "not_a_candidate") return "This object no longer needs the fix in the newest backup. Reload the page.";
  if (status === 0) return "Keel could not be reached. Check your connection and try again.";
  return "Keel could not plan the fix. Try again.";
}

/** Why a planned fix cannot go ahead, from the worker's message, in plain words. */
export function fixPlanProblem(message: string | null | undefined): string {
  const text = message ?? "";
  if (/already passes/.test(text)) return "This object already passes in the live tenant. Nothing needs to change.";
  if (/not in the tenant now/.test(text)) return "This object is no longer in the tenant, so there is nothing to fix.";
  if (/no complete backup holds/.test(text)) return "No finished backup holds this object yet. Run a backup, then try again.";
  if (/no complete service read holds/.test(text)) return "No finished backup holds this policy yet. Run a backup, then try again.";
  if (/could not be checked/.test(text)) return "Keel could not read this policy in the live tenant just now. Try again in a few minutes.";
  if (/points to other objects/.test(text)) return "This object points to other objects, so Keel cannot change one setting on its own. Fix it in Microsoft 365.";
  if (/not updated in place/.test(text)) return "Keel would have to recreate this object, not change one setting. Fix it in Microsoft 365.";
  if (/incident/.test(text)) return "The backup lies inside an open incident. Plan the fix from the incident instead.";
  return "Keel could not plan the fix. The details are below.";
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

/* ------------------------------------------------------------------- score -- */

// How many checked controls pass. Only controls Keel could judge count: a control that
// could not be checked, or has nothing to check here, is left out. An accepted
// exception still counts as not passing, and is shown apart beside the score.
export interface ComplianceScore {
  passed: number;
  // Controls Keel could judge: passes, fails, not set up yet and accepted exceptions.
  evaluated: number;
  excepted: number;
  // Passes ÷ evaluated, rounded down so a score never reads 100% with a fail left.
  percent: number | null;
}

/** How the score is worked out, said once beside it. */
export const SCORE_EXPLAINED = "Passes out of every control Keel could check. Controls it could not check are left out.";

export function scoreOf(passed: number, evaluated: number, excepted: number): ComplianceScore {
  return { passed, evaluated, excepted, percent: evaluated ? Math.floor((passed / evaluated) * 100) : null };
}

export function complianceScore(findings: ComplianceFinding[]): ComplianceScore {
  const judged = findings.filter((finding) => finding.verdict === "pass" || finding.verdict === "fail");
  return scoreOf(
    judged.filter((finding) => finding.verdict === "pass").length,
    judged.length,
    judged.filter((finding) => resultOf(finding) === "excepted").length,
  );
}

/** The same score from the engine's summary (used where the findings are not loaded). */
export function scoreFromSummary(summary: ComplianceSummary): ComplianceScore {
  return scoreOf(summary.passing, summary.passing + summary.exposed + summary.excepted, summary.excepted);
}

/** Green at 90% and over, amber from 60%, red below; grey while nothing was judged. */
export function scoreTone(score: ComplianceScore): "fine" | "soon" | "urgent" | "neutral" {
  if (score.percent === null) return "neutral";
  if (score.percent >= 90) return "fine";
  return score.percent >= 60 ? "soon" : "urgent";
}

/** "3 of 4 checked controls pass", with any accepted exception said apart. */
export function scoreSentence(score: ComplianceScore): string {
  if (score.percent === null) return "Nothing checked yet";
  const passes = `${score.passed} of ${plural(score.evaluated, "checked control")} ${score.passed === 1 ? "passes" : "pass"}`;
  return score.excepted ? `${passes} · ${plural(score.excepted, "accepted exception")}` : passes;
}

export interface ScoreGroup { key: string; label: string; icon?: IconName; score: ComplianceScore }

/** A score per standard, in name order (Keel's own checks first). */
export function scoresByStandard(findings: ComplianceFinding[]): ScoreGroup[] {
  const keys = [...new Set(findings.map(standardName))];
  return keys
    .sort((left, right) => (left === "Keel checks" ? -1 : right === "Keel checks" ? 1 : left.localeCompare(right)))
    .map((key) => ({ key, label: key, score: complianceScore(findings.filter((finding) => standardName(finding) === key)) }));
}

/** A score per Microsoft service, in the portal's service order. */
export function scoresByService(findings: ComplianceFinding[], order: (code: string) => number): ScoreGroup[] {
  const services = new Map<string, CloudService>();
  for (const finding of findings) services.set(controlService(finding).code, controlService(finding));
  return [...services.values()]
    .sort((left, right) => order(left.code) - order(right.code))
    .map((service) => ({ key: service.code, label: service.name, icon: service.icon, score: complianceScore(findings.filter((finding) => controlService(finding).code === service.code)) }));
}
