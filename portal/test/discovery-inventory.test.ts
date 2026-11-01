import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DiscoveryInventoryView } from "@/components/discovery-inventory";
import {
  catalogueSentence,
  notUsedSentence,
  containerLine,
  discoveryHeadline,
  onePerType,
  powershellNoteSentence,
  powershellNotes,
  skippedSentence,
  sourceProblems,
  typeLabel,
  unreadableSentence,
  type DiscoveryInventoryData,
} from "@/lib/discovery";

const NOW = "2026-10-14T14:00:00.000Z";

const item = (extra: Partial<DiscoveryInventoryData["items"][number]>): DiscoveryInventoryData["items"][number] => ({
  source: "graph:v1.0", name: "/bookingBusinesses", kind: "entitySet", entityType: "bookingBusiness", status: "uncatalogued",
  catalogTypes: [], objects: 2, objectsExact: true, httpStatus: 200, reason: null, message: null, missingGrant: null, grantSource: null,
  ...extra,
});

const DATA: DiscoveryInventoryData = {
  id: "7",
  startedAt: "2026-10-14T11:50:00.000Z",
  finishedAt: "2026-10-14T12:00:00.000Z",
  sources: [
    { source: "graph:v1.0", status: "complete", error: null, metadataVersion: "4.0", paths: 409 },
    { source: "powershell:MicrosoftTeams", status: "unknown", error: "no command list was supplied for this module", metadataVersion: null, paths: 0 },
  ],
  summary: {
    types: 53, catalogued: 48, uncatalogued: 2, skipped: 1, unreadable: 1, "not-listed": 1,
    containers: { users: { objects: 1234, exact: true }, groups: { objects: 5000, exact: false }, teams: null, sites: { objects: null, exact: null, reason: "missing-grant", missingGrant: "Sites.Read.All" } },
    catalogue: { covered: 59, "under-item": 3 },
  },
  catalogue: [{ type: "user", path: "/users", version: "v1.0", coverage: "covered", objects: 1234, reason: null, missingGrant: null }],
  items: [
    item({}),
    item({ source: "powershell:ExchangeOnlineManagement", name: "Get-JournalRule", kind: "cmdlet", entityType: null, objects: null, objectsExact: null, httpStatus: null }),
    item({ name: "/auditLogs/signIns", entityType: "signIn", status: "skipped", reason: "not-configuration" }),
    item({ name: "/print/printers", entityType: "printer", status: "unreadable", objects: null, objectsExact: null, httpStatus: 403, reason: "missing-grant", message: "Authorization_RequestDenied: denied", missingGrant: "Printer.Read.All", grantSource: "graph" }),
  ],
};

test("the discovery sentences lead with the answer", () => {
  assert.equal(discoveryHeadline(DATA), "Discovery found 53 types: 48 types backed up, 2 readable but not backed up yet, 1 not worth backing up, 1 KEEL cannot read, 1 not checked this run.");
  assert.equal(catalogueSentence(DATA), "The one type KEEL backs up was found and read.");
  assert.equal(containerLine(DATA), "Users 1,234 · Groups at least 5,000 · Teams unknown · Sites unknown");
  // A PowerShell area that was not listed is a note, never an error line.
  assert.deepEqual(sourceProblems(DATA), []);
  assert.deepEqual(sourceProblems({ ...DATA, sources: [{ ...DATA.sources[0], status: "partial", error: "stopped at 5 of 9 paths" }] }), ["Microsoft Graph was only partly read (stopped at 5 of 9 paths)."]);
  assert.deepEqual(powershellNotes(DATA), [{ area: "Teams", reason: null }]);
  assert.equal(powershellNoteSentence(powershellNotes(DATA)), "Not checked this run: Teams settings that need PowerShell. Their backups are not affected; the next discovery run tries again.");
  assert.equal(powershellNoteSentence([{ area: "Exchange Online and Purview", reason: "x" }, { area: "Teams", reason: null }, { area: "SharePoint", reason: null }]),
    "Not checked this run: Exchange Online and Purview, Teams and SharePoint settings that need PowerShell. Their backups are not affected; the next discovery run tries again.");
  assert.equal(powershellNoteSentence([]), null);
  assert.equal(typeLabel({ kind: "navigation", name: "/deviceManagement/deviceConfigurations", entityType: "deviceConfiguration" }), "Device configuration");
  assert.equal(typeLabel({ kind: "entitySet", name: "/oauth2PermissionGrants", entityType: "oAuth2PermissionGrant" }), "OAuth2 permission grant");
  assert.equal(unreadableSentence({ reason: "missing-grant", missingGrant: "Printer.Read.All", grantSource: "graph" }), "Not read: KEEL's app is not allowed to read it. It needs the Printer.Read.All permission.");
  assert.equal(unreadableSentence({ reason: "refused-with-grant", missingGrant: null, grantSource: null }), "Not read: Microsoft refused it, although KEEL's app holds the permission this area usually needs.");
  assert.equal(discoveryHeadline({ ...DATA, summary: { ...DATA.summary, skipped: undefined } }), "Discovery found 53 types: 48 types backed up, 2 readable but not backed up yet, 1 KEEL cannot read, 1 not checked this run.");
  assert.equal(skippedSentence({ reason: "microsoft-published" }), "Not backed up: Microsoft publishes the same list in every tenant.");
  assert.equal(skippedSentence({ reason: "holds-secrets" }), "Not backed up: it holds passwords or codes KEEL does not store, and little else.");
  assert.equal(skippedSentence({ reason: "retired" }), "Not backed up: it configures a product Microsoft retired or never shipped.");
  assert.equal(skippedSentence({ reason: "other-tenant" }), "Not backed up: it only exists while another tenant or a partner takes part, so it is set up again with them.");
  assert.equal(unreadableSentence({ reason: "not-licensed", missingGrant: null, grantSource: null }), "Not read: the tenant is not licensed for it.");
});

test("the section lists what is not backed up and what cannot be read, with paths under Technical details", () => {
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: DATA, now: NOW }));
  assert.match(html, /What the tenant holds/);
  assert.match(html, /checked 2 hours ago/);
  assert.match(html, /Not backed up yet \(2\)/);
  assert.match(html, /KEEL cannot read \(1\)/);
  assert.match(html, /Not worth backing up \(1\)/);
  assert.match(html, /Not backed up: it holds logs, reports or activity, not settings\./);
  assert.match(html, /Booking business/);
  assert.match(html, /2 settings/);
  assert.match(html, /Get-JournalRule/);
  assert.match(html, /It needs the Printer\.Read\.All permission/);
  // The raw path appears only inside the record layer.
  const visible = html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /\/print\/printers|\/bookingBusinesses|\/auditLogs/);
  assert.match(html, /Exchange Online and Purview \(PowerShell\)/);
});

test("PowerShell areas that could not be listed show a calm note, with the reason under Technical details", () => {
  const listed: DiscoveryInventoryData = {
    ...DATA,
    sources: [
      DATA.sources[0],
      { source: "powershell:ExchangeOnlineManagement", status: "unknown", error: "Security & Compliance: could not connect: timed out", metadataVersion: null, paths: 0 },
      { source: "powershell:MicrosoftTeams", status: "complete", error: null, metadataVersion: null, paths: 412 },
    ],
  };
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: listed, now: NOW }));
  assert.match(html, /class="discovery-note" role="note"/);
  assert.match(html, /Not checked this run: Exchange Online and Purview settings that need PowerShell\. Their backups are not affected/);
  assert.doesNotMatch(html, /action-error/);
  assert.doesNotMatch(html, /cmdlet list was not supplied/);
  const visible = html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /could not connect/);
  assert.match(html, /could not connect: timed out/);

  const complete = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: { ...listed, sources: [DATA.sources[0], listed.sources[2]] }, now: NOW }));
  assert.doesNotMatch(complete, /discovery-note/);
});

test("before the first run the section says discovery has not run", () => {
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: null, now: NOW }));
  assert.match(html, /Discovery has not run for this tenant yet/);
});

test("backed-up types the tenant does not use are listed apart, not as unread", () => {
  const data: DiscoveryInventoryData = {
    ...DATA,
    catalogue: [
      ...DATA.catalogue,
      { type: "lifecycleWorkflow", path: "/identityGovernance/lifecycleWorkflows/workflows", version: "v1.0", coverage: "not-used", objects: null, reason: "not-licensed", missingGrant: null },
      { type: "identityApiConnector", path: "/identity/apiConnectors", version: "v1.0", coverage: "not-used", objects: null, reason: "feature-off", missingGrant: null },
    ],
  };
  assert.equal(catalogueSentence(data), "Every type KEEL backs up that this tenant uses was found and read (1). 2 types are not used in this tenant.");
  assert.equal(notUsedSentence({ reason: "not-licensed" }), "Not used in this tenant: the tenant has no licence for it. Nothing to back up.");
  assert.equal(notUsedSentence({ reason: "not-set-up" }), "Not used in this tenant: it has never been set up in this tenant. Nothing to back up.");
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data, now: NOW }));
  assert.match(html, /Not used in this tenant \(2\)/);
  assert.match(html, /Lifecycle workflow/);
  assert.doesNotMatch(html, /Backed-up types not found/);

  const withGap: DiscoveryInventoryData = {
    ...data,
    catalogue: [...data.catalogue, { type: "printer", path: "/print/printers", version: "v1.0", coverage: "unreadable", objects: null, reason: "missing-grant", missingGrant: "Printer.Read.All" }],
  };
  assert.equal(catalogueSentence(withGap), "1 type KEEL backs up was not found or could not be read. 2 types are not used in this tenant.");
  const gapHtml = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: withGap, now: NOW }));
  assert.match(gapHtml, /Backed-up types not found \(1\)/);
  assert.match(gapHtml, /Printer.Read.All permission/);
});

test("the headline total equals its parts, and each list holds as many types as its part says", () => {
  // A path found in v1.0 and beta is one type; a type readable in one version is not
  // listed as unreadable in the other. The stored run counted 1,487 types while the
  // headline parts summed to 1,437 and the lists showed 824 unreadable for 574.
  const both = (extra: Partial<DiscoveryInventoryData["items"][number]>) => [item({ ...extra, source: "graph:beta" }), item(extra)]; // beta first, as the store sorts them
  const raw: DiscoveryInventoryData = {
    ...DATA,
    summary: { ...DATA.summary, types: 999, catalogued: 999, uncatalogued: 999, skipped: 999, unreadable: 999, "not-listed": 999 },
    items: [
      ...both({ name: "/users", entityType: "user", status: "catalogued" }),
      // Backed up through v1.0, refused through beta: backed up, not unreadable.
      item({ name: "/groups", entityType: "group", status: "catalogued" }),
      item({ source: "graph:beta", name: "/groups", entityType: "group", status: "unreadable", reason: "error" }),
      ...both({}),
      ...both({ name: "/auditLogs/signIns", entityType: "signIn", status: "skipped", reason: "not-configuration" }),
      ...both({ name: "/print/printers", entityType: "printer", status: "unreadable", reason: "missing-grant", missingGrant: "Printer.Read.All", grantSource: "graph" }),
      item({ source: "powershell:MicrosoftTeams", name: "Get-CsTeamsMeetingPolicy", kind: "cmdlet", entityType: null, status: "not-listed" }),
    ],
  };
  const data = onePerType(raw);
  const { summary } = data;
  assert.deepEqual(
    { types: summary.types, catalogued: summary.catalogued, uncatalogued: summary.uncatalogued, skipped: summary.skipped, unreadable: summary.unreadable, notListed: summary["not-listed"] },
    { types: 6, catalogued: 2, uncatalogued: 1, skipped: 1, unreadable: 1, notListed: 1 },
  );
  assert.equal(summary.catalogued + summary.uncatalogued + (summary.skipped ?? 0) + summary.unreadable + summary["not-listed"], summary.types);

  // Every number in the headline adds up to the total it opens with.
  const headline = discoveryHeadline(data);
  const [total, ...parts] = [...headline.matchAll(/\d[\d,]*/g)].map((match) => Number(match[0].replaceAll(",", "")));
  assert.equal(parts.reduce((sum, part) => sum + part, 0), total, headline);

  // Each list's count matches its headline part.
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data, now: NOW }));
  assert.match(html, new RegExp(`Not backed up yet \\(${summary.uncatalogued}\\)`));
  assert.match(html, new RegExp(`KEEL cannot read \\(${summary.unreadable}\\)`));
  assert.match(html, new RegExp(`Not worth backing up \\(${summary.skipped}\\)`));
  assert.equal(data.items.filter((entry) => entry.status === "unreadable").length, summary.unreadable);
  // A type found in both versions shows the v1.0 row (its count and source).
  assert.deepEqual([...new Set(data.items.filter((entry) => entry.source.startsWith("graph:")).map((entry) => entry.source))], ["graph:v1.0"]);
});
