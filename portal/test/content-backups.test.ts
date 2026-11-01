import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentBackups, ContentBackupsView } from "@/components/content-backups";
import {
  contentHeadline,
  contentRows,
  holdingLine,
  runLine,
  runScope,
  runSkipped,
  scopeSentence,
  skippedLine,
  scopeWords,
  CONTENT_WORKLOADS,
  type ContentBackup,
  type ContentBackupsData,
} from "@/lib/content-backups-view";

const NOW = "2026-10-16T12:00:00.000Z";
const stored = (items: number, bytes: number, containers = 1, versions = items) => ({ items, versions, containers, bytes, storedBytes: bytes, newestAt: "2026-10-16T01:05:00.000Z" });
const run = (workload: string, outcome: string, extra: Partial<ContentBackup> = {}, at = "2026-10-16T01:10:00.000Z"): ContentBackup => ({
  workload,
  latest: { id: `run-${workload}`, outcome, at, reasons: outcome === "succeeded" ? [] : ["KEEL-RT-group: HTTP 503"], namePrefix: "KEEL-RT-" },
  lastGood: outcome === "succeeded" ? { id: `run-${workload}`, from: "2026-10-16T01:00:00.000Z", at, items: 2, bytes: 2048 } : null,
  stored: null,
  ...extra,
});

// The 2026-10-16 nightly run (Q91), every workload succeeded.
const DATA: ContentBackupsData = {
  generatedAt: NOW,
  content: [
    run("exchange-mail", "succeeded", { stored: stored(23, 15468, 2) }),
    { workload: "group-conversations", latest: null, lastGood: null, stored: stored(3, 9496) },
    run("onedrive", "succeeded", { stored: stored(2, 1771) }),
    run("planner", "succeeded", { stored: stored(5, 2479) }),
    run("sharepoint-sites", "succeeded", { stored: stored(888, 7733964, 1, 901) }),
    run("teams", "succeeded", { stored: stored(11, 271885, 11) }),
  ],
};

test("every content workload gets a row, with what it holds summed over its stored codes", () => {
  const rows = contentRows(DATA);
  assert.deepEqual(rows.map((row) => row.workload.code), ["exchange-mail", "onedrive", "sharepoint-sites", "teams", "planner"]);
  const planner = rows.find((row) => row.workload.code === "planner")!;
  assert.equal(planner.items, 8, "Planner and group conversations are one collector");
  assert.equal(planner.bytes, 2479 + 9496);
  assert.equal(holdingLine(rows[0]), "23 content items · 15 KB · in 2 mailboxes");
  assert.equal(holdingLine(rows[2]), "888 content items · 7.4 MB · in 1 site");
  assert.ok(rows.every((row) => row.state === "backed-up"));
  assert.equal(contentHeadline(rows), "Keel holds 932 content items (7.7 MB) across 5 workloads. The last nightly run backed up all 5.");
  assert.equal(runLine(rows[0]), "Last run stored 2 new content items or versions (2.0 KB)");
});

test("scope is the newest run's name prefix, and Teams reads every team", () => {
  assert.equal(runScope(DATA), "KEEL-RT-");
  const [mail, , , teams] = CONTENT_WORKLOADS;
  assert.equal(scopeWords(mail, "KEEL-RT-"), "Only mailboxes whose names start with KEEL-RT-");
  assert.equal(scopeWords(mail, null), "Every mailbox in the tenant");
  assert.equal(scopeWords(mail, undefined), "Scope shown after the next nightly run");
  assert.equal(scopeWords(teams, "KEEL-RT-"), "Every team: Teams has no name filter");
  assert.match(scopeSentence("KEEL-RT-")!, /only for names starting with KEEL-RT-/);
  assert.equal(scopeSentence(null), "Content is backed up for the whole tenant.");
  assert.equal(scopeSentence(undefined), null);
  assert.equal(runScope({ generatedAt: NOW, content: [{ workload: "teams", latest: null, lastGood: null, stored: stored(1, 1) }] }), undefined);
});

test("a failed, partial or old run says so, and content stored before runs were recorded still counts", () => {
  const data: ContentBackupsData = {
    generatedAt: NOW,
    content: [
      run("exchange-mail", "failed", { stored: stored(23, 15468) }),
      run("onedrive", "partial", { stored: stored(2, 1771) }),
      run("teams", "succeeded", { stored: stored(11, 271885) }, "2026-10-13T01:10:00.000Z"),
      { workload: "sharepoint-sites", latest: null, lastGood: null, stored: stored(888, 7733964) },
    ],
  };
  const rows = contentRows(data);
  const state = Object.fromEntries(rows.map((row) => [row.workload.code, row.state]));
  assert.deepEqual(state, { "exchange-mail": "failed", onedrive: "partial", "sharepoint-sites": "held", teams: "stale", planner: "never" });
  assert.equal(runLine(rows[0]), "Last run failed. Microsoft 365 had a temporary fault.");
  assert.equal(runLine(rows[1]), "Last run could not read 1 part. Microsoft 365 had a temporary fault.");
  assert.match(runLine(rows[2])!, /Stored before Keel recorded each run/);
  assert.equal(runLine(rows[4]), null);
  assert.match(contentHeadline(rows), /did not finish for Mail, OneDrive files\.$/);
  assert.equal(contentHeadline(contentRows({ generatedAt: NOW, content: [] })), "Keel has not backed up any content yet. The nightly content backup runs at 01:00 UTC.");
});

test("the section leads with the answer, lists every workload, and names the Teams messages gap", () => {
  const html = renderToStaticMarkup(createElement(ContentBackupsView, { data: DATA, now: NOW }));
  assert.match(html, /Keel holds 932 content items/);
  for (const name of ["Mail", "OneDrive files", "SharePoint sites and files", "Teams structure", "Planner and group conversations"]) assert.ok(html.includes(name), name);
  assert.match(html, /Teams chat and channel messages are not backed up yet/);
  assert.match(html, /Only sites whose names start with KEEL-RT-/);
  assert.match(renderToStaticMarkup(createElement(ContentBackups, { data: undefined, now: NOW })), /could not read the content backups/);
});

test("OneDrives Microsoft 365 has locked are listed as skipped, not as a problem", () => {
  const skipped = [
    "KEEL-RT-adele@keelrt.example: OneDrive locked in Microsoft 365",
    "KEEL-RT-alex@keelrt.example: OneDrive locked in Microsoft 365",
  ];
  const onedrive = run("onedrive", "succeeded", { stored: stored(2, 1771) });
  const data: ContentBackupsData = { generatedAt: NOW, content: [{ ...onedrive, latest: { ...onedrive.latest!, skipped } }] };
  const row = contentRows(data).find((candidate) => candidate.workload.code === "onedrive")!;
  assert.equal(row.state, "backed-up");
  assert.equal(skippedLine(row), "Skipped 2 OneDrives Microsoft 365 has locked. Keel cannot read them, so this is not counted as an error");
  assert.deepEqual(runSkipped(row), skipped);
  const html = renderToStaticMarkup(createElement(ContentBackupsView, { data, now: NOW }));
  assert.match(html, /Skipped 2 OneDrives Microsoft 365 has locked/);
  assert.match(html, /KEEL-RT-adele@keelrt.example: OneDrive locked in Microsoft 365/);
  assert.equal(skippedLine(contentRows(DATA).find((candidate) => candidate.workload.code === "onedrive")!), null);
});
