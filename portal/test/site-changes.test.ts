import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { recordSharePointRun } from "../../engine/collect/workloads/sharepoint.mjs";
import { detectWorkloadDrift } from "../../engine/govern/workloadDrift.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { SiteChanges } from "@/components/site-changes";
import { changesVerdict } from "@/lib/changes-view";
import { siteChangeLine, siteChangeName, type SiteChange } from "@/lib/site-changes-view";
import { loadSiteChanges } from "@/lib/site-permissions";

// Site permissions audit: a change the SharePoint read finds between two daily reads
// (workload_drift) is listed on the Changes page, newest per site, with its alert.

const TENANT = "site-changes-portal-test";
const HOST = "contoso.sharepoint.com";
const FINANCE = `${HOST},11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222`;
const ARCHIVE = `${HOST},33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444`;
const observed = (operation: string) => ({ status: "observed", operation });
const GRANT = { id: "aTowaS50fG1zLnNwLmV4dGVybmFs", roles: ["write"], applications: [{ id: "a0a00000-0000-4000-8000-0000000000a1", displayName: "Payroll connector" }] };

const site = (siteId: string, displayName: string, grants: unknown[]) => ({
  siteId,
  fields: { displayName, webUrl: `https://${HOST}/sites/${displayName.toLowerCase()}`, appPermissionGrants: grants },
  fieldCoverage: { displayName: observed("sharepoint.site-properties"), webUrl: observed("sharepoint.site-properties"), appPermissionGrants: observed("sharepoint.site-permissions") },
});

const run = (at: string, sites: ReturnType<typeof site>[]) => ({
  workload: "sharepoint-site-settings", tenantHost: HOST, outcome: "complete", observedFrom: at, observedTo: at, sites,
  tenant: { fields: {}, fieldCoverage: {} }, discovery: null, fieldCounts: {}, outOfScope: [],
});

test("the loader lists the newest change per site within the window, with the site's name and its alert", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const now = new Date("2026-10-15T12:00:00.000Z");
    assert.deepEqual(await loadSiteChanges(client, { tenantRef: TENANT, now }), { days: 30, changes: [] });

    const record = async (tenantRef: string, at: string, sites: ReturnType<typeof site>[]) => {
      const stored = await recordSharePointRun(client, { tenantRef, result: run(at, sites) });
      await detectWorkloadDrift(client, { collectionId: stored.id, hysteresis: undefined });
      return stored.id;
    };
    // Too old for the window: Archive's grant changed 40 days ago.
    await record(TENANT, "2026-09-04T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [])]);
    await record(TENANT, "2026-09-05T02:00:00.000Z", [site(FINANCE, "Finance", []), site(ARCHIVE, "Archive", [GRANT])]);
    // An app is given access to Finance, then Finance is renamed and Archive is gone.
    const granted = await record(TENANT, "2026-10-13T02:00:00.000Z", [site(FINANCE, "Finance", [GRANT]), site(ARCHIVE, "Archive", [GRANT])]);
    const renamed = await record(TENANT, "2026-10-14T02:00:00.000Z", [site(FINANCE, "Finance team", [GRANT])]);
    // Another tenant's change is never shown here.
    await record("other-tenant", "2026-10-13T02:00:00.000Z", [site(FINANCE, "Elsewhere", [])]);
    await record("other-tenant", "2026-10-14T02:00:00.000Z", [site(FINANCE, "Elsewhere", [GRANT])]);
    await client.query(
      `UPDATE alert SET state = 'acknowledged' WHERE tenant_ref = $1 AND resource_key = $2`,
      [TENANT, `sharepoint-site-settings:site:${FINANCE}`],
    );

    const data = await loadSiteChanges(client, { tenantRef: TENANT, now });
    assert.equal(data.changes.length, 2);
    const [finance, archive] = [...data.changes].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
    assert.equal(finance.name, "Finance team");
    assert.equal(finance.changeType, "modified");
    assert.deepEqual(finance.fields.sort(), ["displayName", "webUrl"]);
    assert.equal(finance.blastRadius, "cosmetic");
    assert.equal(finance.collectionId, renamed);
    assert.equal(finance.previousCollectionId, granted);
    assert.equal(finance.alertState, "acknowledged");
    assert.equal(finance.seenAt, "2026-10-14T02:00:00.000Z");
    // A removed site keeps the name it had in the read before.
    assert.equal(archive.name, "Archive");
    assert.equal(archive.changeType, "removed");
    assert.equal(archive.siteId, ARCHIVE);
    assert.equal(archive.alertState, "open");

    assert.equal((await loadSiteChanges(client, { tenantRef: TENANT, now, limit: 1 })).changes.length, 1);
    // A wider window reaches the older change, but still one entry per site.
    assert.equal((await loadSiteChanges(client, { tenantRef: TENANT, now, days: 60 })).changes.length, 2);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

const NOW = "2026-10-15T12:00:00.000Z";
const change = (over: Partial<SiteChange>): SiteChange => ({
  id: "d1a00000-0000-4000-8000-0000000000d1", resourceKey: `site:${FINANCE}`, siteId: FINANCE, name: "Finance",
  changeType: "modified", fields: ["appPermissionGrants"], blastRadius: "access-affecting", seenAt: "2026-10-15T02:00:00.000Z",
  collectionId: "c0110000-0000-4000-8000-0000000000c2", previousCollectionId: "c0110000-0000-4000-8000-0000000000c1",
  alertId: "a1e70000-0000-4000-8000-0000000000a1", alertState: "open", ...over,
});

test("each change reads in words", () => {
  assert.equal(siteChangeLine(change({})), "App access changed.");
  assert.equal(siteChangeLine(change({ fields: ["displayName", "webUrl", "appPermissionGrants"] })), "Name, web address and app access changed.");
  assert.equal(siteChangeLine(change({ fields: ["someNewField"] })), "Some new field changed.");
  assert.equal(siteChangeLine(change({ changeType: "added", fields: [] })), "A new site was found.");
  assert.equal(siteChangeLine(change({ changeType: "removed", fields: [] })), "The site was not found in the newest read.");
  assert.equal(siteChangeName(change({ resourceKey: "tenant", siteId: null, name: null })), "Tenant sharing settings");
  assert.equal(siteChangeName(change({ name: null })), "A site with no name");
});

test("the Changes verdict counts site permission changes still waiting for review", () => {
  assert.deepEqual(changesVerdict([], "2026-10-01T00:00:00.000Z", NOW, 2), {
    text: "Nothing has changed since the baseline set 14 days ago, but 2 site permission changes wait for review.", tone: "attention",
  });
  assert.equal(changesVerdict([], "2026-10-01T00:00:00.000Z", NOW).tone, "good");
  assert.match(changesVerdict([], null, NOW, 1).text, /; 1 site permission change waits for review\.$/);
  for (const waiting of [0, 1, 12]) {
    for (const baseline of [null, "2026-10-01T00:00:00.000Z"]) {
      assert.ok(changesVerdict([], baseline, NOW, waiting).text.split(/\s+/).length <= 25);
    }
  }
});

test("the list links each site to its page, points open alerts to the Alerts page, and keeps ids under Technical details", () => {
  const html = renderToStaticMarkup(createElement(SiteChanges, {
    now: NOW,
    data: { days: 30, changes: [
      change({}),
      change({ id: "d1a00000-0000-4000-8000-0000000000d2", resourceKey: `site:${ARCHIVE}`, siteId: ARCHIVE, name: "Archive", changeType: "removed", fields: [], alertState: "acknowledged" }),
    ] },
  }));
  assert.ok(html.includes(`href="/sites/${HOST}%2C11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222"`));
  // A removed site has no page to open.
  assert.ok(!html.includes(`href="/sites/${HOST}%2C33333333`));
  assert.match(html, /href="\/alerts"[^>]*>Review the open alert on the Alerts page/);
  assert.match(html, /Alert: open/);
  assert.match(html, /Alert: acknowledged/);
  assert.match(html, /seen 10 hours ago/);
  const outside = html.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "").replace(/href="[^"]*"/g, "");
  assert.doesNotMatch(outside, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.doesNotMatch(outside, /site:contoso/);
  assert.match(html, /a1e70000-0000-4000-8000-0000000000a1/);

  const empty = renderToStaticMarkup(createElement(SiteChanges, { now: NOW, data: { days: 30, changes: [] } }));
  assert.match(empty, /No site settings changed in the last 30 days\./);
  assert.doesNotMatch(empty, /Alerts page<\/a>/);
});
