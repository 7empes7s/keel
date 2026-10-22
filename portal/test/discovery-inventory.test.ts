import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DiscoveryInventoryView } from "@/components/discovery-inventory";
import {
  catalogueSentence,
  containerLine,
  discoveryHeadline,
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
  assert.equal(discoveryHeadline(DATA), "Discovery found 53 types: 48 types backed up, 2 readable but not backed up yet, 1 not worth backing up, 1 KEEL cannot read.");
  assert.equal(catalogueSentence(DATA), "The one type KEEL backs up was found and read.");
  assert.equal(containerLine(DATA), "Users 1,234 · Groups at least 5,000 · Teams unknown · Sites unknown");
  assert.deepEqual(sourceProblems(DATA), ["PowerShell, MicrosoftTeams: the cmdlet list was not supplied, so its cmdlets are not checked."]);
  assert.equal(typeLabel({ kind: "navigation", name: "/deviceManagement/deviceConfigurations", entityType: "deviceConfiguration" }), "Device configuration");
  assert.equal(typeLabel({ kind: "entitySet", name: "/oauth2PermissionGrants", entityType: "oAuth2PermissionGrant" }), "OAuth2 permission grant");
  assert.equal(unreadableSentence({ reason: "missing-grant", missingGrant: "Printer.Read.All", grantSource: "graph" }), "Not read: KEEL's app is not allowed to read it. It needs the Printer.Read.All permission.");
  assert.equal(unreadableSentence({ reason: "refused-with-grant", missingGrant: null, grantSource: null }), "Not read: Microsoft refused it, although KEEL's app holds the permission this area usually needs.");
  assert.equal(discoveryHeadline({ ...DATA, summary: { ...DATA.summary, skipped: undefined } }), "Discovery found 53 types: 48 types backed up, 2 readable but not backed up yet, 1 KEEL cannot read.");
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
  assert.match(html, /2 objects/);
  assert.match(html, /Get-JournalRule/);
  assert.match(html, /It needs the Printer\.Read\.All permission/);
  // The raw path appears only inside the record layer.
  const visible = html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /\/print\/printers|\/bookingBusinesses|\/auditLogs/);
});

test("before the first run the section says discovery has not run", () => {
  const html = renderToStaticMarkup(createElement(DiscoveryInventoryView, { data: null, now: NOW }));
  assert.match(html, /Discovery has not run for this tenant yet/);
});
