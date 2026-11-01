import assert from "node:assert/strict";
import { test } from "node:test";

import { computeFreshness } from "../../engine/coverage/recoveryMetrics.mjs";
import { contentDependency, workloadDependency } from "../../engine/coverage/serviceBackups.mjs";
import { serviceBackupsForIncident } from "../../engine/govern/incidents.mjs";
import { recordSentence, recordTitle, type AnswerRecord } from "@/lib/ask-view";
import { OTHER_SERVICES, incidentServiceGroups, orderServiceBackups, serviceBackupLine, serviceBackupStatus, serviceGroupWords } from "@/lib/incidents-view";
import type { IncidentServiceBackup } from "@/lib/portal-data";
import { dependencyName, freshnessSentence, serviceBackupSentence, servicesSentence, type RecoveryMetrics, type ServiceBackup } from "@/lib/resilience-view";
import { backupView } from "@/lib/value-report-view";

// The reports that measure backups (Resilience, Ask, the value report, Incidents) name
// the service settings and content backups beside Entra ID and Intune, in plain words.

const NOW = "2026-10-03T12:00:00.000Z";

test("freshness names a service settings or content backup when it is the oldest", () => {
  const freshness = computeFreshness({
    required: [workloadDependency("exchange-mail-flow"), contentDependency("exchange-mail")],
    observations: [
      { dependency: "workload:exchange-mail-flow", success: true, startedAt: "2026-10-03T02:00:00.000Z", completedAt: "2026-10-03T02:05:00.000Z" },
      { dependency: "content:exchange-mail", success: true, startedAt: "2026-10-02T01:00:00.000Z", completedAt: "2026-10-02T01:05:00.000Z" },
    ],
    now: NOW,
  });
  assert.equal(dependencyName(freshness.oldestDependency!), "Mail, calendars and contacts (content)");
  assert.equal(dependencyName("workload:exchange-mail-flow"), "Exchange mail flow settings");
  assert.match(freshnessSentence({ freshness } as unknown as RecoveryMetrics), /35 hours old: Mail, calendars and contacts \(content\)/);
});

test("each service backup says when it last backed up well and what it holds", () => {
  const mail: ServiceBackup = {
    kind: "content", workload: "exchange-mail", name: "Mail, calendars and contacts", service: "Exchange", switchedOn: true,
    latest: { id: "r2", outcome: "failed", at: "2026-10-03T01:00:00.000Z", namePrefix: "KEEL-RT-" },
    lastGood: { id: "r1", from: "2026-10-02T01:00:00.000Z", at: "2026-10-02T01:05:00.000Z", items: 2, bytes: 10 },
    stored: { items: 23, versions: 30, containers: 3, bytes: 15468, storedBytes: 15000, newestAt: null },
  };
  const line = serviceBackupSentence(mail, NOW);
  assert.match(line, /^Last good backup .*\. The latest try failed\. Holds 23 content items \(15 KB\)\. Limited to names starting KEEL-RT-\.$/);
  const off: ServiceBackup = { ...mail, kind: "service-settings", switchedOn: false };
  assert.equal(serviceBackupSentence(off, NOW), "Switched off until a live check on this tenant passes.");
  assert.equal(servicesSentence({ services: { settings: [off], content: [mail] } } as unknown as RecoveryMetrics),
    "1 of 1 service backups beyond Entra ID and Intune have a good copy; each counts toward the age above.");
  assert.equal(servicesSentence({} as RecoveryMetrics), "Only the Entra ID and Intune settings backup has run so far.");
});

test("Ask names service settings and content records, never by their codes", () => {
  const base = { kind: "coverage", window: { from: null, to: NOW }, source: { kind: "collection", id: "x", href: "/protect" } };
  const settings = { ...base, id: "workload/teams-org-policies", backup: "service-settings", resourceType: "teams-org-policies", name: "Teams organization policy", outcome: "complete", count: 9 } as AnswerRecord;
  const content = { ...base, id: "content/teams", backup: "content", resourceType: "teams", name: "Teams, channels and tabs", outcome: "succeeded", count: 11 } as AnswerRecord;
  const off = { ...settings, outcome: "disabled", count: null } as AnswerRecord;
  assert.equal(recordTitle(settings), "Teams organization policy (settings)");
  assert.equal(recordSentence(settings), "Read completely. 9 settings.");
  assert.equal(recordTitle(content), "Teams, channels and tabs (content)");
  assert.equal(recordSentence(content), "Backed up. 11 content items stored.");
  assert.equal(recordSentence(off), "Switched off until a live check passes. No read has finished yet.");
});

test("the value report shows what was backed up per family as tiles and areas, problems first", () => {
  const view = backupView({
    withheld: false,
    settings: { backups: 30, lastAt: NOW },
    serviceSettings: { runs: 300, workloads: 11, expected: 12, lastAt: NOW },
    content: { runs: 150, workloads: 6, expected: 6, lastAt: NOW, itemsStored: 932, bytesStored: 8_035_063 },
  });
  assert.equal(view.state, "shown");
  if (view.state !== "shown") return;
  assert.deepEqual(view.tiles.map((tile) => [tile.label, tile.count, tile.of, tile.tone]), [
    ["Entra ID and Intune", 30, null, "fine"],
    ["Service settings", 11, 12, "soon"],
    ["Content", 6, 6, "fine"],
  ]);
  assert.equal(view.tiles[1].detail, "areas backed up · 300 good runs");
  assert.equal(view.tiles[1].problem, "1 did not run", "an older report without areas still names the gap");
  assert.equal(view.tiles[2].detail, "areas backed up · 932 new content items stored (7.7 MB)");
  assert.deepEqual(view.headline, { text: "1 area needs a look", tone: "soon" });
  assert.deepEqual(view.groups, [], "an older report without areas has no table");
  assert.equal(backupView({ withheld: true }).state, "withheld");
  const missing = backupView(undefined);
  assert.ok(missing.state === "missing" && /before backups of every service were counted/.test(missing.text));
});

test("a content run read only in part shows as a problem, so stored items never contradict the area count", () => {
  // The live report of 2026-10-22: mail read in part by a run that stopped before the other areas.
  const area = (workload: string, state: "good" | "partial" | "failed" | "not-run", goodRuns = 0) => ({ workload, state, goodRuns, partialRuns: state === "partial" ? 1 : 0, failedRuns: state === "failed" ? 1 : 0, lastGoodAt: goodRuns ? NOW : null });
  const view = backupView({
    withheld: false,
    settings: { backups: 420, lastAt: NOW },
    serviceSettings: { runs: 108, workloads: 2, expected: 3, partial: 0, failed: 1, notRun: 0, lastAt: NOW, areas: [area("exchange-mail-flow", "good", 60), area("teams-org-policies", "failed"), area("purview-labels", "good", 48)] },
    content: {
      runs: 0, workloads: 0, expected: 5, partial: 1, failed: 0, notRun: 4, lastAt: null, itemsStored: 4094, bytesStored: 225_270_538,
      areas: [area("exchange-mail", "partial"), area("onedrive", "not-run"), area("planner", "not-run"), area("sharepoint-sites", "not-run"), area("teams", "not-run")],
    },
  });
  assert.equal(view.state, "shown");
  if (view.state !== "shown") return;
  const content = view.tiles[2];
  assert.deepEqual([content.count, content.of, content.tone, content.problem], [0, 5, "urgent", "1 in part · 4 did not run"]);
  assert.equal(content.detail, "areas backed up · 4094 new content items stored (215 MB)");
  assert.match(view.note ?? "", /including content from areas backed up only in part/);
  assert.deepEqual(view.headline, { text: "6 areas need a look", tone: "urgent" });
  assert.deepEqual(view.groups.map((group) => group.label), ["Service settings", "Content"], "the group with a failure comes first");
  assert.deepEqual(view.groups[0].rows.map((row) => row.state), ["failed", "good", "good"], "problems first inside each group");
  assert.deepEqual(view.groups[1].rows.map((row) => [row.name, row.state]), [
    ["Mail, calendars and contacts", "partial"],
    ["OneDrive files", "not-run"],
    ["Planner plans and tasks", "not-run"],
    ["SharePoint sites, lists and files", "not-run"],
    ["Teams, channels and tabs", "not-run"],
  ]);
  assert.ok(view.groups.flatMap((group) => group.rows).every((row) => !row.name.includes("-")), "areas are named, never by their codes");
});

test("Incidents place each service backup against the attack window", () => {
  const intervals = [{ startsAt: "2026-10-02T00:00:00.000Z", endsAt: null }];
  const [entry] = serviceBackupsForIncident([
    { kind: "service-settings", workload: "exchange-mail-flow", id: "b", from: "2026-10-03T02:00:00.000Z", at: "2026-10-03T02:05:00.000Z" },
    { kind: "service-settings", workload: "exchange-mail-flow", id: "a", from: "2026-10-01T02:00:00.000Z", at: "2026-10-01T02:05:00.000Z" },
  ], intervals) as IncidentServiceBackup[];
  assert.equal(entry.name, "Exchange mail flow or protection rule");
  assert.equal(entry.newestGood?.inCompromiseWindow, true);
  assert.equal(entry.beforeWindow?.id, "a");
  assert.match(serviceBackupLine(entry, NOW), /^Newest good backup .*, taken during the attack\. The newest from before the attack is .*\.$/);
});

test("Incidents show each other service's backup as a status badge, problems first", () => {
  const base = { service: null, assessed: false as const, beforeWindow: null };
  const good = { at: "2026-10-01T00:00:00.000Z", from: null, id: "g", inCompromiseWindow: false };
  const during = { ...good, id: "d", inCompromiseWindow: true };
  const entries: IncidentServiceBackup[] = [
    { ...base, kind: "service-settings", workload: "exchange-mail-flow", name: "Mail flow", newestGood: good },
    { ...base, kind: "content", workload: "teams", name: "Teams", newestGood: during, beforeWindow: good },
    { ...base, kind: "content", workload: "planner", name: "Planner", newestGood: null },
    { ...base, kind: "content", workload: "onedrive", name: "OneDrive", newestGood: during },
  ];
  assert.deepEqual(orderServiceBackups(entries).map((entry) => [entry.name, serviceBackupStatus(entry).label, serviceBackupStatus(entry).tone]), [
    ["Planner", "No good backup", "urgent"],
    ["OneDrive", "Only during the attack", "urgent"],
    ["Teams", "Use the one from before", "soon"],
    ["Mail flow", "Outside the attack", "fine"],
  ]);
});

test("Incidents list every other service in the portal's order, none left out", () => {
  const good = { at: "2026-10-01T00:00:00.000Z", from: null, id: "g", inCompromiseWindow: false };
  const base = { assessed: false as const, beforeWindow: null, newestGood: good };
  const entries: IncidentServiceBackup[] = [
    { ...base, kind: "content", workload: "exchange-mail", name: "Mail, calendars and contacts", service: "Exchange" },
    { ...base, kind: "service-settings", workload: "exchange-mail-flow", name: "Mail flow", service: "Exchange" },
    { ...base, kind: "service-settings", workload: "exchange-recipients", name: "Recipients", service: "Exchange" },
    { ...base, kind: "service-settings", workload: "purview-labels", name: "Sensitivity labels", service: "Purview", newestGood: null },
    { ...base, kind: "content", workload: "planner", name: "Planner", service: "Planner" },
  ];
  const groups = incidentServiceGroups(entries);
  // Entra ID and Intune are the checked rows, so they are not repeated here.
  assert.deepEqual(groups.map((group) => group.service?.name ?? "Other services"), [
    "Exchange Online", "SharePoint and OneDrive", "Teams", "Power Platform", "Purview", "Defender", "Other services",
  ]);
  assert.equal(OTHER_SERVICES.length, 6);
  // Inside a service: settings in the portal's order (people before policies), then content.
  assert.deepEqual(groups[0].entries.map((entry) => entry.name), ["Recipients", "Mail flow", "Mail, calendars and contacts"]);
  assert.deepEqual(serviceGroupWords(groups[0].entries), { count: "3 types", about: "Backed up outside the attack · check by hand" });
  assert.deepEqual(serviceGroupWords(groups[4].entries), { count: "1 type", about: "1 with no good backup" });
  assert.deepEqual(serviceGroupWords([]), { count: "No backup yet", about: "Nothing to restore from" });
  // A find keeps only services with something that matches, by kind or service name.
  assert.deepEqual(incidentServiceGroups(entries, "label").map((group) => group.service?.name), ["Purview"]);
  assert.deepEqual(incidentServiceGroups(entries, "exchange online").map((group) => group.entries.length), [3]);
});
