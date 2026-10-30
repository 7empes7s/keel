import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FindingRecordFields } from "@/components/compliance/compliance-record";

import { addDays, endOfDay, grantException } from "@/lib/compliance-change";
import {
  complianceCounts,
  complianceScore,
  complianceStatus,
  complianceVerdict,
  CHECK_LINE_LIMIT,
  checkSubjectWord,
  checkCounts,
  checkCountRecord,
  failingBadge,
  failingMore,
  checksCapped,
  controlChecks,
  controlMisses,
  controlName,
  controlService,
  standardName,
  exceptionChip,
  exceptionRefusal,
  findingTypes,
  grantLabel,
  lastChecked,
  linkedChangeName,
  orderFindings,
  ownerName,
  reasonWords,
  resultLine,
  resultOf,
  countsFromSummary,
  scoreFromSummary,
  scoreSentence,
  scoresByService,
  scoresByStandard,
  scoreTone,
  settingValueWords,
  settingWords,
  fixSetting,
  storageSentence,
} from "@/lib/compliance-view";
import { serviceOrder } from "@/lib/services";
import { databaseIsLocal } from "@/lib/runtime-config";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";
import { renderComplianceAt } from "./render-compliance";

const NOW = "2026-10-02T09:40:00Z";
const NONE = { state: "none" as const, linked: [], mismatched: [] };
const finding = (id: string, controlId: string, verdict: ComplianceFinding["verdict"], extra: Partial<ComplianceFinding> = {}): ComplianceFinding => ({
  id: `e7a10000-0000-4000-8000-0000000000${id}`, controlId, title: "Registry wording", framework: "keel-custom", edition: "1", profile: "default", evaluatorVersion: 1,
  verdict, reason: null, evaluatedAt: "2026-10-02T09:20:00Z", evidenceSeq: null, exceptionState: "none", exception: null,
  exposed: verdict === "fail", evidence: [], links: { backup: NONE, change: NONE, restorePlan: NONE }, ...extra,
});
const ROLE = "keel-custom.role-assignment.admin-count-at-most";
const LOCATION = "keel-custom.named-location.no-untrusted-all-countries";
const GROUP = "keel-custom.group.role-assignable-not-synced";
const ENDED = finding("e1", ROLE, "fail", {
  exceptionState: "expired",
  exception: { id: "x1", owner: "secops@contoso.com", reason: "Migration", grantedBy: "p1", grantedAt: "2026-09-01T10:00:00Z", expiresAt: "2026-09-30T09:40:00Z" },
  links: { backup: NONE, restorePlan: NONE, change: { state: "linked", mismatched: [], linked: [{ id: "d1", naturalKey: "roleAssignment:Global Administrator · adele.vance@contoso.com", resourceType: "roleAssignment", changeType: "added", snapshotId: "s1", detectedAt: "2026-10-02T09:14:00Z" }] } },
});
const ACCEPTED = finding("e2", LOCATION, "fail", {
  exposed: false, exceptionState: "authorized",
  exception: { id: "x2", owner: "amara@contoso.example", reason: "Proxy", grantedBy: "p1", grantedAt: "2026-09-15T10:00:00Z", expiresAt: "2026-11-30T00:00:00Z", ownerRef: { kind: "person", id: "p2", name: "Amara Okafor", href: "/principals" } },
});
const STALE = finding("e3", GROUP, "unknown", { reason: "group:stale-observation" });
const PASS = finding("e4", "keel-custom.conditional-access.block-legacy", "pass");
const DATA: ComplianceData = {
  generatedAt: NOW, activeBaseline: null,
  summary: { controls: 4, exposed: 1, excepted: 1, expiredExceptions: 1, incompleteExceptions: 0, passing: 1, unknown: 1, notApplicable: 0 },
  storage: { configured: true, provider: "local-disk", region: "westeurope", boundary: null, immutability: "unsupported", generatedAt: null, certifies: null, source: "/x" } as ComplianceData["storage"],
  findings: [PASS, STALE, ACCEPTED, ENDED],
};

test("Compliance words: plain titles, results, reasons, owners and the verdict", () => {
  assert.equal(controlName(ENDED), "No more than 5 people hold the top admin role");
  assert.equal(controlName(finding("e9", "custom.unknown", "pass", { title: null })), "A control Keel no longer holds");
  assert.equal(findingTypes(ACCEPTED), "trusted locations");
  assert.equal(controlService(STALE).name, "Entra ID");
  assert.deepEqual([ENDED, ACCEPTED, STALE, PASS].map(resultOf), ["failing", "excepted", "unknown", "passing"]);
  // Worst first: a fail, then a control that could not be checked, then an accepted exception.
  assert.deepEqual(orderFindings(DATA.findings).map((item) => item.id), [ENDED.id, STALE.id, ACCEPTED.id, PASS.id]);
  assert.equal(resultLine(ENDED, NOW), "Exception ended 2 days ago");
  assert.equal(resultLine(ACCEPTED, NOW), "Accepted until 30 Nov 2026");
  assert.equal(reasonWords(STALE), "The newest group backup is too old for this check.");
  assert.equal(reasonWords(finding("e8", ROLE, "unknown", { reason: "roleAssignment:no-observation" })), "No backup of admin role assignments has been made yet.");
  // A CISA ScubaGear rule Keel cannot run says why, never with the code behind it.
  const scuba = (reason: string) => reasonWords(finding("e9", ROLE, "unknown", { reason }));
  assert.equal(scuba("scubagear:check-by-hand"), "CISA lists this as a check to do by hand.");
  assert.equal(scuba("scubagear:not-read:dmarc_records"), "Keel does not back up the settings this rule reads yet.");
  assert.equal(scuba("scubagear:field-not-read:org_config.AuditDisabled"), "A setting this rule reads is not in Keel's backup yet.");
  assert.equal(scuba("scubagear:preview-only:conditional_access_policies.AgentIdRiskLevels"),
    "This rule reads settings Microsoft offers only in a preview, which Keel does not back up.");
  assert.equal(scuba("scubagear:incomplete:privileged_users"), "The backup cannot answer what this rule asks.");
  assert.equal(scuba("scubagear:no-result"), "Keel could not run this rule.");
  assert.equal(scuba("scubagear:needs-setting:SecuritySuite,Defender"), "This rule needs a list only you can give, such as your sensitive users or partner domains, and Keel cannot take it yet.");
  // A rule Keel cannot check has no evidence, so it is filed under its product's service.
  const scubaRule = (profile: string) => controlService({ ...finding("e10", "scubagear.MS.X.1.1v1", "unknown", { reason: "scubagear:check-by-hand" }), framework: "cisa-scuba", profile, evidence: [] });
  assert.deepEqual(["aad", "exo", "securitysuite", "sharepoint", "teams", "powerplatform", "powerbi"].map((profile) => scubaRule(profile).name),
    ["Entra ID", "Exchange Online", "Defender", "SharePoint and OneDrive", "Teams", "Power Platform", "Power Platform"]);
  assert.equal(standardName({ ...finding("e11", "scubagear.MS.X.1.1v1", "pass"), framework: "cisa-scuba" }), "CISA SCuBA");
  assert.equal(ownerName(ENDED), "Secops");
  assert.equal(ownerName(ACCEPTED), "Amara Okafor");
  assert.deepEqual(exceptionChip(ENDED, NOW), { tone: "urgent", label: "Ended 2 days ago" });
  assert.equal(grantLabel(ENDED), "Renew the exception");
  assert.equal(grantLabel(finding("e7", ROLE, "fail")), "Grant an exception");
  assert.equal(linkedChangeName(ENDED.links.change.linked[0]), "Global Administrator · Adele Vance added");

  const counts = complianceCounts(DATA.findings);
  assert.deepEqual([counts.failing, counts.excepted, counts.unknown, counts.passing, counts.ended], [1, 1, 1, 1, 1]);
  assert.deepEqual(complianceStatus(counts), { tone: "urgent", label: "1 failing" });
  assert.equal(complianceVerdict(DATA).text, "1 control fails, and its exception ended 2 days ago.");
  assert.equal(complianceVerdict({ ...DATA, findings: [PASS, ACCEPTED] }).text, "All 2 checked controls pass or have a current exception.");
  assert.equal(complianceVerdict({ ...DATA, findings: [PASS, STALE] }).text, "No control fails; 1 control could not be checked.");
  assert.deepEqual(complianceStatus(complianceCounts([])), { tone: "low", label: "Not checked yet" });
  assert.equal(storageSentence(DATA.storage), "Backups are kept on this server's disk (West Europe).");
  assert.equal(exceptionRefusal(400, "expiry_in_future"), "Pick an end date after today.");
  assert.equal(exceptionRefusal(403, "forbidden"), "You need the configuration permission to grant an exception.");
});

test("Compliance body: a tile sets result=, the filter shows only that result, no email or code in view", async () => {
  const all = await renderComplianceAt("", { data: DATA, canConfigure: true, now: NOW });
  assert.match(all, /href="\/benchmarks\?result=failing"/);
  for (const name of ["No more than 5 people hold the top admin role", "No trusted location trusts unknown countries", "Groups that grant admin roles are not copied from on-premises", "Old sign-in methods are blocked"]) assert.ok(all.includes(name), name);
  assert.match(all, /href="\/benchmarks\?open=e7a10000-0000-4000-8000-0000000000e1"/);
  assert.match(all, /Renew exception/);
  const failing = await renderComplianceAt("result=failing", { data: DATA, canConfigure: true, now: NOW });
  assert.match(failing, /Showing <b>1<\/b> of 4 controls/);
  assert.match(failing, /href="\/benchmarks\?result=failing%2Cpassing"/, "Passing adds to Failing");
  const list = failing.slice(failing.indexOf('aria-labelledby="cp-controls-heading"'));
  assert.ok(list.includes("No more than 5 people hold the top admin role"));
  assert.ok(!list.slice(0, list.indexOf("cp-storage")).includes("Old sign-in methods are blocked"));

  const visible = all
    .replace(/<details class="technical-details"[\s\S]*?<\/details>/g, "")
    .replace(/\s(data-row-id|href|title|id|for|aria-labelledby)="[^"]*"/g, "")
    .replace(/<[^>]+>/g, " ");
  for (const banned of ["@contoso", "westeurope", "KEEL", "Baseline", "Conditional Access", "Named location", "keel-custom"]) assert.ok(!visible.includes(banned), banned);
  assert.doesNotMatch(visible, /[0-9a-f]{8}-[0-9a-f]{4}-/);

  const viewer = await renderComplianceAt("", { data: DATA, canConfigure: false, now: NOW });
  assert.doesNotMatch(viewer, /Renew exception|Grant exception|btn-primary/);
});

test("Nothing checked yet: every empty state names the next step with a button", async () => {
  const unset = { configured: false, provider: null, region: null, boundary: null, immutability: "unknown", generatedAt: null, certifies: null, source: null } as ComplianceData["storage"];
  const empty: ComplianceData = { ...DATA, findings: [], storage: unset, summary: { ...DATA.summary, controls: 0 } };
  assert.equal(complianceVerdict(empty).detail, "Keel checks these after each backup. Results show here after the next backup or check.");
  assert.equal(lastChecked([], NOW), null);
  assert.equal(lastChecked(DATA.findings, NOW), "Last checked 20 minutes ago.");

  // Someone who runs backups: Check now in the verdict and in the empty list.
  const operator = await renderComplianceAt("", { data: empty, canConfigure: false, canCheck: true, now: NOW });
  assert.match(operator, /<button[^>]*class="btn btn-primary primary"[^>]*>Check now<\/button>/);
  assert.equal((operator.match(/>Check now<\/button>/g) ?? []).length, 2);
  assert.match(operator, /Keel checks these after each backup\./);
  assert.doesNotMatch(operator, /does not run these checks/);
  // Storage not known: tinted, says what to do, and links to the storage section.
  assert.match(operator, /class="cp-storage" data-tone="soon"/);
  assert.match(operator, /Ask whoever runs the Keel server to record where backups are stored\./);
  assert.match(operator, /href="\/resilience#storage"[^>]*>.*See backup storage<\/a>/);

  // A viewer cannot run a check: a link to when backups run, never a dead end.
  const viewer = await renderComplianceAt("", { data: empty, canConfigure: false, now: NOW });
  assert.doesNotMatch(viewer, /Check now/);
  assert.match(viewer, /href="\/schedules"[^>]*>See when backups run<\/a>/);

  // With results: when they were made, and Check now beside it; storage known has no button.
  const checked = await renderComplianceAt("", { data: DATA, canConfigure: true, canCheck: true, now: NOW });
  assert.match(checked, /Results come from the last check\. Last checked 20 minutes ago\./);
  assert.equal((checked.match(/>Check now<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(checked, /See backup storage/);
});

test("Backups sit on this server when Keel's database does", () => {
  for (const url of ["postgres://keel@localhost:5432/keel", "postgresql://keel:pw@127.0.0.1/keel", "postgres://[::1]/keel", "postgres:///keel", "postgres://keel@/keel?host=/var/run/postgresql"]) {
    assert.equal(databaseIsLocal(url), true, url);
  }
  for (const url of ["postgres://keel@db.example.com/keel", "postgres://keel@10.0.0.4/keel", "not a url"]) assert.equal(databaseIsLocal(url), false, url);
});

test("Defender email controls: filed under Defender, and what fails is named by policy and setting in plain words", () => {
  const mail = (controlId: string, extra: Partial<ComplianceFinding> = {}) => finding("d1", controlId, "fail", { evidence: [{ resourceType: "exchange-mail-flow", window: { startedAt: null, endedAt: null }, snapshotId: null, collectionId: "c1", completedAt: "2026-10-02T02:00:00Z" }], ...extra });
  const spam = mail("keel-custom.defender-email.anti-spam-phish-quarantined", {
    details: [
      { subject: "Default", setting: "HighConfidencePhishAction", value: "MoveToJmf", expected: "Quarantine" },
      { subject: "Sales", setting: "PhishZapEnabled", value: false, expected: true },
    ],
  });
  assert.equal(controlName(spam), "Phishing mail goes to quarantine");
  assert.equal(controlService(spam).name, "Defender");
  assert.equal(findingTypes(spam), "mail protection policies");
  // A result stored before passing lines existed has no `ok`: its lines are failing ones.
  assert.deepEqual(controlMisses(spam), [
    { subject: "Default", setting: "High-confidence phishing goes to", now: "Junk folder", shouldBe: "Quarantine", ok: false },
    { subject: "Sales", setting: "Pulls back delivered phishing", now: "Off", shouldBe: "On", ok: false },
  ]);
  assert.equal(checkSubjectWord(spam), "Policy");
  assert.deepEqual(controlMisses(PASS), []);
  assert.deepEqual([settingValueWords(["partner.test", "x.test"]), settingValueWords([]), settingValueWords(null)], ["partner.test, x.test", "None", "Not set"]);
  for (const id of ["anti-phish-spoof-protection", "anti-spam-no-allowed-domains", "malware-file-filter", "safe-links-email"]) {
    const control = mail(`keel-custom.defender-email.${id}`);
    assert.notEqual(controlName(control), "Registry wording", id);
    assert.equal(controlService(control).name, "Defender", id);
  }
  // Could not check: said of the mail protection backup, never "policie".
  assert.equal(reasonWords(mail("keel-custom.defender-email.malware-file-filter", { verdict: "unknown", reason: "exchange-mail-flow:observation-partial" })), "The newest mail protection backup did not finish.");
  assert.equal(reasonWords(mail("keel-custom.defender-email.malware-file-filter", { verdict: "unknown", reason: "exchange-mail-flow:no-observation" })), "No backup of mail protection policies has been made yet.");
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("Grant an exception posts to the compliance route and words a refusal", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return calls.length === 1 ? new Response("{}", { status: 201 }) : Response.json({ error: "expiry_in_future" }, { status: 400 });
  }) as typeof fetch;
  const body = { evaluationId: ENDED.id, owner: "secops@contoso.com", reason: "Cut-over", expiresAt: endOfDay(addDays("2026-10-02", 90))! };
  assert.deepEqual(await grantException(body), { ok: true });
  assert.deepEqual(await grantException(body), { ok: false, reason: "Pick an end date after today." });
  assert.equal(calls[0].url, "/api/actions/compliance/exception");
  assert.deepEqual(calls[0].body, { ...body, expiresAt: "2026-12-31T23:59:59.000Z" });
});

const MISSING = finding("e5", "keel-custom.conditional-access.block-legacy", "fail", { reason: "not-configured" });
const NOT_RELEVANT = finding("e6", LOCATION, "not-applicable");

test("Not set up yet: a fail because the setting does not exist reads apart from a wrong setting", () => {
  assert.equal(resultOf(MISSING), "not-set-up");
  assert.equal(resultLine(MISSING, NOW), "The setting does not exist yet");
  // Under an exception in force it is accepted like any other fail.
  assert.equal(resultOf({ ...MISSING, exposed: false, exceptionState: "authorized" }), "excepted");
  const counts = complianceCounts([MISSING, PASS]);
  assert.deepEqual([counts.failing, counts["not-set-up"], counts.passing], [0, 1, 1]);
  assert.deepEqual(complianceStatus(counts), { tone: "soon", label: "1 not set up yet" });
  assert.equal(complianceVerdict({ ...DATA, findings: [MISSING, PASS] }).text, "No control fails, but 1 is not set up yet.");
  assert.equal(complianceVerdict({ ...DATA, findings: [ENDED, MISSING] }).text, "1 control fails, and its exception ended 2 days ago; 1 control is not set up yet.");
  assert.deepEqual(orderFindings([PASS, MISSING, ENDED]).map(resultOf), ["failing", "not-set-up", "passing"]);
  // The summary form agrees with the findings form.
  const fromSummary = countsFromSummary({ controls: 2, exposed: 1, notConfigured: 1, excepted: 0, expiredExceptions: 0, incompleteExceptions: 0, passing: 1, unknown: 0, notApplicable: 0 });
  assert.deepEqual([fromSummary.failing, fromSummary["not-set-up"]], [0, 1]);
});

test("Compliance score: passes over every control Keel could judge, exceptions shown apart", () => {
  // PASS passes; ENDED and MISSING fail; ACCEPTED is excepted; STALE and NOT_RELEVANT are left out.
  const score = complianceScore([PASS, ENDED, MISSING, ACCEPTED, STALE, NOT_RELEVANT]);
  assert.deepEqual(score, { passed: 1, evaluated: 4, excepted: 1, percent: 25 });
  assert.equal(scoreSentence(score), "1 of 4 checked controls passes · 1 accepted exception");
  assert.equal(scoreTone(score), "urgent");
  // Rounded down: 2 of 3 is 66%, and 99.x% never reads as 100%.
  assert.equal(complianceScore([PASS, PASS, ENDED]).percent, 66);
  assert.equal(complianceScore([...Array.from({ length: 199 }, () => PASS), ENDED]).percent, 99);
  assert.deepEqual(complianceScore([PASS, PASS]), { passed: 2, evaluated: 2, excepted: 0, percent: 100 });
  assert.equal(scoreTone(complianceScore([PASS, PASS])), "fine");
  assert.equal(scoreTone(complianceScore([PASS, PASS, PASS, ENDED])), "soon");
  // Nothing Keel could judge: no score, never 0% or 100%.
  const none = complianceScore([STALE, NOT_RELEVANT]);
  assert.equal(none.percent, null);
  assert.equal(scoreTone(none), "neutral");
  assert.equal(scoreSentence(none), "Nothing checked yet");
  assert.equal(complianceScore([]).percent, null);
  // The summary gives the same score as the findings.
  assert.deepEqual(scoreFromSummary({ controls: 6, exposed: 2, notConfigured: 1, excepted: 1, expiredExceptions: 1, incompleteExceptions: 0, passing: 1, unknown: 1, notApplicable: 1 }), score);
});

test("Compliance score per standard and per service", () => {
  const other = finding("f1", "pack.sample", "pass", { framework: "nist-800-53", evidence: [{ resourceType: "conditionalAccessPolicy" } as never] });
  const standards = scoresByStandard([PASS, ENDED, other]);
  assert.deepEqual(standards.map((group) => [group.label, group.score.percent]), [["Keel checks", 50], ["NIST SP 800-53", 100]]);
  const services = scoresByService([PASS, ENDED, ACCEPTED], serviceOrder);
  assert.deepEqual(services.map((group) => [group.label, group.score.passed, group.score.evaluated]), [["Entra ID", 1, 3]]);
});

test("Settings checked: expected against current for every setting, failing first, in plain words", () => {
  const location = finding("n1", "keel-custom.named-location.no-untrusted-all-countries", "fail", {
    details: [
      { subject: "Office", setting: "includeUnknownCountriesAndRegions", value: false, expected: false, ok: true },
      { subject: "Anywhere", setting: "includeUnknownCountriesAndRegions", value: true, expected: false, ok: false },
    ],
  });
  assert.deepEqual(controlChecks(location), [
    { subject: "Anywhere", setting: "Takes in unknown countries", now: "Yes", shouldBe: "No", ok: false },
    { subject: "Office", setting: "Takes in unknown countries", now: "No", shouldBe: "No", ok: true },
  ]);
  assert.equal(controlMisses(location).length, 1);
  assert.equal(checkSubjectWord(location), "Location");

  const admins = finding("r1", "keel-custom.role-assignment.admin-count-at-most", "pass", {
    details: [{ subject: "Global Administrator", setting: "assignmentCount", value: 3, expected: { atMost: 5 }, ok: true }],
  });
  assert.deepEqual(controlChecks(admins), [{ subject: "Global Administrator", setting: "People who hold it", now: "3", shouldBe: "5 or fewer", ok: true }]);
  assert.equal(checkSubjectWord(admins), "Role");
  assert.equal(checkSubjectWord(finding("g1", "keel-custom.group.role-assignable-not-synced", "pass")), "Group");
  assert.equal(settingValueWords(true, "onPremisesSyncEnabled"), "Yes");
  assert.equal(settingValueWords(true, "ZapEnabled"), "On");
  // Legacy sign-in: each blocking sign-in rule, named, with what it misses.
  const legacy = finding("l1", "keel-custom.conditional-access.block-legacy", "fail", {
    details: [
      { subject: "KEEL-RT-report", setting: "state", value: "enabledForReportingButNotEnforced", expected: "enabled", ok: false },
      { subject: "KEEL-RT-block", setting: "includeUsers", value: "Only some", expected: "All", ok: false },
      { subject: "KEEL-RT-block", setting: "clientAppTypes", value: ["exchangeActiveSync", "other"], expected: ["exchangeActiveSync", "other"], ok: true },
      { subject: "KEEL-RT-block", setting: "includeApplications", value: "None", expected: "All", ok: false },
    ],
  });
  assert.deepEqual(controlChecks(legacy), [
    { subject: "KEEL-RT-report", setting: "Status", now: "Report-only", shouldBe: "On", ok: false },
    { subject: "KEEL-RT-block", setting: "Users it covers", now: "Only some users", shouldBe: "All users", ok: false },
    { subject: "KEEL-RT-block", setting: "Apps it covers", now: "No apps", shouldBe: "All apps", ok: false },
    { subject: "KEEL-RT-block", setting: "Old sign-in methods it blocks", now: "Exchange ActiveSync, Other old clients", shouldBe: "Exchange ActiveSync, Other old clients", ok: true },
  ]);
  assert.equal(checkSubjectWord(legacy), "Sign-in rule");
  assert.equal(settingValueWords([], "clientAppTypes", legacy.controlId), "None");
  // Two rules with the same name arrive from the engine already numbered; each keeps its lines.
  const twins = finding("l2", "keel-custom.conditional-access.block-legacy", "fail", {
    details: [
      { subject: "KEEL-RT-Block legacy (1 of 2)", setting: "includeUsers", value: "Only some", expected: "All", ok: false },
      { subject: "KEEL-RT-Block legacy (2 of 2)", setting: "state", value: "disabled", expected: "enabled", ok: false },
    ],
  });
  assert.deepEqual(controlChecks(twins).map((check) => [check.subject, check.setting, check.now]), [
    ["KEEL-RT-Block legacy (1 of 2)", "Users it covers", "Only some users"],
    ["KEEL-RT-Block legacy (2 of 2)", "Status", "Off"],
  ]);
  // The sign-in rule words belong to that control: another control's "state" or
  // "includeUsers" lines keep their own names and values.
  const other = finding("o1", "own.check-state", "fail", {
    details: [
      { subject: "Device policy", setting: "state", value: "enabled", expected: "disabled", ok: false },
      { subject: "Device policy", setting: "includeUsers", value: ["All"], expected: [], ok: false },
    ],
  });
  assert.deepEqual(controlChecks(other).map((check) => [check.setting, check.now, check.shouldBe]), [
    ["state", "enabled", "disabled"],
    ["includeUsers", "All", "None"],
  ]);
  assert.equal(settingValueWords("enabled", "state"), "enabled");
  assert.equal(settingWords("state"), "state");
  assert.equal(settingWords("state", legacy.controlId), "Status");
  assert.equal(fixSetting(finding("f1", "own.check-state", "fail", { fix: { resourceType: "x", field: "state", to: "disabled" } })), "State");
  // A full list may have been cut short by the engine, so its counts are "at least".
  const line = { subject: "Default", setting: "On", now: "On", shouldBe: "On", ok: true };
  assert.equal(checksCapped(Array.from({ length: CHECK_LINE_LIMIT - 1 }, () => line)), false);
  assert.equal(checksCapped(Array.from({ length: CHECK_LINE_LIMIT }, () => line)), true);
});

test("check counts cover every setting checked, past the 50 lines a result keeps", () => {
  const line = (ok: boolean) => ({ subject: "KEEL-RT-Location", setting: "includeUnknownCountriesAndRegions", value: !ok, expected: false, ok });
  const lines = [line(false), line(false), line(false), ...Array.from({ length: 47 }, () => line(true))];
  const cut = { ...PASS, verdict: "fail" as const, details: lines, detailCounts: { checked: 60, failing: 3 } };
  assert.deepEqual(checkCounts(cut), { checked: 60, failing: 3, passing: 57, listed: 50, exact: true });
  // A result stored before the counts existed counts its lines.
  assert.deepEqual(checkCounts({ ...cut, detailCounts: null }), { checked: 50, failing: 3, passing: 47, listed: 50, exact: false });
  assert.deepEqual(checkCounts({ ...PASS, details: [] }), { checked: 0, failing: 0, passing: 0, listed: 0, exact: false });
});

test("Technical details show the totals past the 50 lines a result keeps", () => {
  const line = (ok: boolean) => ({ subject: "KEEL-RT-Location", setting: "includeUnknownCountriesAndRegions", value: !ok, expected: false, ok });
  const lines = [line(false), line(false), line(false), ...Array.from({ length: 47 }, () => line(true))];
  const cut = { ...PASS, verdict: "fail" as const, details: lines, detailCounts: { checked: 60, failing: 3 } };
  assert.deepEqual(checkCountRecord(cut), { checked: "60", failing: "3", listed: "First 50, failing ones first" });
  // Every setting listed: no "listed" line.
  assert.deepEqual(checkCountRecord({ ...cut, details: lines.slice(0, 10), detailCounts: { checked: 10, failing: 3 } }), { checked: "10", failing: "3", listed: null });
  // Stored before the counts existed with a full list: only "or more" can be said.
  assert.deepEqual(checkCountRecord({ ...cut, detailCounts: null }), { checked: "50 or more", failing: "3", listed: "First 50, failing ones first" });
  assert.deepEqual(checkCountRecord({ ...cut, details: Array.from({ length: 50 }, () => line(false)), detailCounts: null }), { checked: "50 or more", failing: "50 or more", listed: "First 50, failing ones first" });
  assert.equal(checkCountRecord({ ...PASS, details: [] }), null);

  // The control sheet's red badge says the same "or more" as the record, and only then.
  const allFailing = { ...cut, details: Array.from({ length: 50 }, () => line(false)), detailCounts: null };
  assert.equal(failingMore(checkCounts(allFailing)), true);
  assert.equal(failingMore(checkCounts({ ...cut, detailCounts: null })), false);
  assert.equal(failingMore(checkCounts({ ...allFailing, detailCounts: { checked: 50, failing: 50 } })), false);
  assert.equal(failingBadge(checkCounts(allFailing)), "50 or more settings");
  assert.equal(failingBadge(checkCounts({ ...cut, detailCounts: null })), "3 settings");
  assert.equal(failingBadge(checkCounts({ ...cut, details: [line(false)], detailCounts: { checked: 1200, failing: 1 } })), "1 setting");
  assert.equal(failingBadge(checkCounts({ ...allFailing, detailCounts: { checked: 1200, failing: 1100 } })), "1,100 settings");

  const html = renderToStaticMarkup(createElement(FindingRecordFields, { finding: { ...cut, detailCounts: { checked: 1200, failing: 55 } } }));
  assert.match(html, /Settings checked[\s\S]*1,200/);
  assert.match(html, /Settings failing[\s\S]*55/);
  assert.match(html, /Settings listed[\s\S]*First 50, failing ones first/);
});
