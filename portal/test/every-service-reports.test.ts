import assert from "node:assert/strict";
import { test } from "node:test";

import { computeFreshness } from "../../engine/coverage/recoveryMetrics.mjs";
import { contentDependency, workloadDependency } from "../../engine/coverage/serviceBackups.mjs";
import { serviceBackupsForIncident } from "../../engine/govern/incidents.mjs";
import { recordSentence, recordTitle, type AnswerRecord } from "@/lib/ask-view";
import { serviceBackupLine } from "@/lib/incidents-view";
import type { IncidentServiceBackup } from "@/lib/portal-data";
import { dependencyName, freshnessSentence, serviceBackupSentence, servicesSentence, type RecoveryMetrics, type ServiceBackup } from "@/lib/resilience-view";
import { backupLines } from "@/lib/value-report-view";

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
  assert.match(line, /^Last good backup .*\. The latest try failed\. Holds 23 items \(15 KB\)\. Limited to names starting KEEL-RT-\.$/);
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
  assert.equal(recordSentence(content), "Backed up. 11 items stored.");
  assert.equal(recordSentence(off), "Switched off until a live check passes. No read has finished yet.");
});

test("the value report lists what was backed up per family", () => {
  const lines = backupLines({
    withheld: false,
    settings: { backups: 30, lastAt: NOW },
    serviceSettings: { runs: 300, workloads: 11, expected: 12, lastAt: NOW },
    content: { runs: 150, workloads: 6, expected: 6, lastAt: NOW, itemsStored: 932, bytesStored: 8_035_063 },
  });
  assert.deepEqual(lines, [
    "Entra ID and Intune settings: 30 complete backups.",
    "Service settings (Exchange, SharePoint, OneDrive, Teams, Purview, Power Platform): 11 of 12 areas backed up, 300 good runs.",
    "Content (mail, files, sites, Teams, Planner): 6 of 6 areas backed up, 150 good runs; 932 new items stored (7.7 MB after removing duplicates).",
  ]);
  assert.match(backupLines({ withheld: true })[0], /whole tenant/);
  assert.match(backupLines(undefined)[0], /before backups of every service were counted/);
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
