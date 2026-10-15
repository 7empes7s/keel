import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { recordSharePointRun } from "../../engine/collect/workloads/sharepoint.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { SiteDetail, SiteList } from "@/components/site-permissions";
import { loadSitePermissions } from "@/lib/site-permissions";
import {
  roleLabel, siteLine, siteVerdict, sitePermissionsFrom, sitesVerdict, type SitePermissionsData,
} from "@/lib/site-permissions-view";

const TENANT = "site-permissions-portal-test";
const HOST = "contoso.sharepoint.com";
const FINANCE = `${HOST},11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222`;
const ARCHIVE = `${HOST},33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444`;
const PAYROLL_APP = "a0a00000-0000-4000-8000-0000000000a1";
const observed = (operation: string) => ({ status: "observed", operation });

const site = (siteId: string, displayName: string, grants: unknown, grantsCoverage: Record<string, unknown> = observed("sharepoint.site-permissions")) => ({
  siteId,
  fields: { displayName, webUrl: `https://${HOST}/sites/${displayName.toLowerCase()}`, ...(grants === undefined ? {} : { appPermissionGrants: grants }) },
  fieldCoverage: { displayName: observed("sharepoint.site-properties"), webUrl: observed("sharepoint.site-properties"), appPermissionGrants: grantsCoverage },
});

const run = (at: string, outcome: string, sites: ReturnType<typeof site>[]) => ({
  workload: "sharepoint-site-settings", tenantHost: HOST, outcome, observedFrom: at, observedTo: at, sites,
  tenant: { fields: {}, fieldCoverage: {} }, discovery: null, fieldCounts: {}, outOfScope: [],
});

test("the loader reads the newest stored read of this tenant, one site or all, and reports a newer failed read", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const now = new Date("2026-10-15T12:00:00.000Z");
    assert.deepEqual(await loadSitePermissions(client, { tenantRef: TENANT, now }), { generatedAt: now.toISOString(), run: null, latest: null, sites: [] });

    await recordSharePointRun(client, { tenantRef: TENANT, result: run("2026-10-13T02:00:00.000Z", "complete", [site(FINANCE, "Finance", [])]) });
    const grant = { id: "aTowaS50fG1zLnNwLmV4dGVybmFs", roles: ["write"], applications: [{ id: PAYROLL_APP, displayName: "Payroll connector" }] };
    const capped = { ...run("2026-10-14T01:00:00.000Z", "partial", []), discovery: { status: "observed", sites: 0, capped: true, maxSites: 0 } };
    await recordSharePointRun(client, { tenantRef: TENANT, result: capped });
    assert.equal((await loadSitePermissions(client, { tenantRef: TENANT, now })).run?.capped, true);
    const stored = await recordSharePointRun(client, { tenantRef: TENANT, result: run("2026-10-14T02:00:00.000Z", "partial", [
      site(FINANCE, "Finance", [grant]),
      site(ARCHIVE, "Archive", undefined, { status: "denied", httpStatus: 403, operation: "sharepoint.site-permissions" }),
    ]) });
    // Another tenant's newer read is never shown here.
    await recordSharePointRun(client, { tenantRef: "other-tenant", result: run("2026-10-15T02:00:00.000Z", "complete", [site(FINANCE, "Elsewhere", [])]) });

    const data = await loadSitePermissions(client, { tenantRef: TENANT, now });
    assert.equal(data.run?.id, stored.id);
    assert.equal(data.run?.capped, false);
    assert.equal(data.latest, null);
    assert.deepEqual(data.sites.map((entry) => entry.displayName), ["Archive", "Finance"]);
    assert.deepEqual(data.sites[1].appGrants, { status: "observed", httpStatus: null, entries: [grant] });
    assert.deepEqual(data.sites[0].appGrants, { status: "denied", httpStatus: 403, entries: null });
    assert.equal(data.sites[1].groups.status, "not-read");

    const one = await loadSitePermissions(client, { tenantRef: TENANT, siteId: FINANCE, now });
    assert.deepEqual(one.sites.map((entry) => entry.siteId), [FINANCE]);
    assert.deepEqual((await loadSitePermissions(client, { tenantRef: TENANT, siteId: "nope", now })).sites, []);

    // A newer read that was switched off stores nothing, so the stored one stays shown and the newer one is named.
    const off = await recordSharePointRun(client, { tenantRef: TENANT, result: { workload: "sharepoint-site-settings", outcome: "disabled", observedFrom: "2026-10-15T02:00:00.000Z", observedTo: "2026-10-15T02:00:00.000Z", reasons: ["not enabled"] } });
    const after = await loadSitePermissions(client, { tenantRef: TENANT, now });
    assert.equal(after.run?.id, stored.id);
    assert.equal(after.latest?.id, off.id);
    assert.equal(after.latest?.outcome, "disabled");
  } finally {
    await client.end();
    await database.cleanup();
  }
});

const NOW = "2026-10-15T12:00:00.000Z";
const RUN = { id: "c0110000-0000-4000-8000-0000000000c1", outcome: "complete" as const, observedTo: "2026-10-15T02:00:00.000Z" };
const FINANCE_SITE = sitePermissionsFrom(`site:${FINANCE}`, {
  displayName: "Finance", webUrl: `https://${HOST}/sites/finance`,
  appPermissionGrants: [
    { id: "g1", roles: ["fullcontrol"], applications: [{ id: PAYROLL_APP, displayName: "Payroll connector" }] },
    { id: "g2", roles: ["read"], applications: [{ id: "a0a00000-0000-4000-8000-0000000000a2", displayName: null }] },
  ],
}, { appPermissionGrants: observed("sharepoint.site-permissions") });

test("each site's permissions read in words, with groups and roles marked as not read yet", () => {
  assert.equal(roleLabel("fullcontrol"), "Full control");
  assert.equal(roleLabel("write"), "Read and write");
  assert.equal(roleLabel("limitedAccess"), "Limited access");
  assert.equal(siteLine(FINANCE_SITE), "2 apps have access · groups and roles not read yet");
  assert.deepEqual(siteVerdict(FINANCE_SITE), { text: "2 apps have access to this site; 1 has full control.", tone: "attention" });

  const denied = sitePermissionsFrom(`site:${ARCHIVE}`, { displayName: "Archive" }, { appPermissionGrants: { status: "denied", httpStatus: 403 } });
  assert.equal(siteLine(denied), "App access unknown · groups and roles not read yet");
  assert.deepEqual(siteVerdict(denied), { text: "App access to this site could not be read.", tone: "attention" });

  // Once the SharePoint read stores groups and role assignments, they show without a portal change.
  const withGroups = sitePermissionsFrom(`site:${ARCHIVE}`, {
    displayName: "Archive", appPermissionGrants: [],
    siteGroups: [{ id: 3, title: "Archive Owners", roles: ["fullcontrol"], members: [{}, {}] }],
    roleAssignments: [{ id: 7, principal: { displayName: "Amara Okafor", kind: "user" }, roles: ["read"] }],
  }, { appPermissionGrants: observed("x"), siteGroups: observed("y"), roleAssignments: observed("z") });
  assert.deepEqual(withGroups.groups.entries, [{ id: "3", name: "Archive Owners", roles: ["fullcontrol"], members: 2 }]);
  assert.deepEqual(withGroups.roleAssignments.entries, [{ id: "7", name: "Amara Okafor", kind: "user", roles: ["read"] }]);
  assert.equal(siteLine(withGroups), "No app access · 1 group, 1 role given");
  assert.deepEqual(siteVerdict(withGroups), { text: "No app has been given access to this site.", tone: "good" });
});

test("the verdict never hides a failed, switched-off or unread SharePoint read", () => {
  const base: SitePermissionsData = { generatedAt: NOW, run: null, latest: null, sites: [] };
  assert.deepEqual(sitesVerdict(base), { text: "KEEL has not read site permissions yet.", tone: "attention" });
  assert.equal(sitesVerdict({ ...base, latest: { ...RUN, outcome: "disabled" } }).tone, "attention");
  assert.deepEqual(sitesVerdict({ ...base, latest: { ...RUN, outcome: "failed" } }), { text: "The last SharePoint read failed, so site permissions are unknown.", tone: "critical" });
  assert.deepEqual(sitesVerdict({ ...base, run: RUN, sites: [FINANCE_SITE] }), { text: "1 site read; 1 has apps with access.", tone: "good" });
  assert.deepEqual(sitesVerdict({ ...base, run: { ...RUN, capped: true }, sites: [FINANCE_SITE] }), { text: "Only the first 1 site was read; the read stops there, so other sites are missing.", tone: "attention" });
  assert.equal(sitesVerdict({ ...base, run: RUN, sites: [FINANCE_SITE], latest: { ...RUN, id: "x", outcome: "failed" } }).tone, "attention");
  for (const data of [base, { ...base, run: RUN, sites: [FINANCE_SITE] }]) {
    assert.ok(sitesVerdict(data).text.split(/\s+/).length <= 25);
  }
});

test("ids stay under Technical details, and every site links to its own page", () => {
  const list = renderToStaticMarkup(createElement(SiteList, { data: { generatedAt: NOW, run: RUN, latest: null, sites: [FINANCE_SITE] } }));
  assert.ok(list.includes(`href="/sites/${HOST}%2C11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222"`));
  assert.match(list, /read 10 hours ago/);
  const detail = renderToStaticMarkup(createElement(SiteDetail, { site: FINANCE_SITE, run: RUN, latest: null, now: NOW }));
  assert.match(detail, /Payroll connector/);
  assert.match(detail, /Full control/);
  assert.match(detail, /An app with no name/);
  assert.match(detail, /KEEL does not read this site&#x27;s SharePoint groups or the roles given to people yet\./);
  // Every id is inside a record (Technical details) block.
  const outside = detail.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(outside, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.match(detail, new RegExp(PAYROLL_APP));

  const read = sitePermissionsFrom(`site:${ARCHIVE}`, {
    displayName: "Archive", siteGroups: [{ id: 3, title: "Archive Owners", roles: ["fullcontrol"], members: [{}] }],
  }, { appPermissionGrants: { status: "failed" }, siteGroups: observed("y") });
  const people = renderToStaticMarkup(createElement(SiteDetail, { site: read, run: RUN, latest: { ...RUN, id: "n", outcome: "failed" }, now: NOW }));
  assert.match(people, /Reading app grants failed\./);
  assert.match(people, /Archive Owners/);
  assert.match(people, /Full control · 1 member/);
  assert.match(people, /KEEL does not read role assignments yet\./);
  assert.match(people, /The newest SharePoint read failed 10 hours ago/);
});
