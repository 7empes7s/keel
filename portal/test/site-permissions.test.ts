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
  SITE_TILES, appStatus, backupStatus, externalStatus, peopleStatus, roleLabel, sharingStatus, siteVerdict, sitePermissionsFrom, sitesInOrder, sitesVerdict,
  tenantSharingWords, type PeopleSummary, type SitePermissions, type SitePermissionsData, type SitesContentRun,
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
    assert.deepEqual(await loadSitePermissions(client, { tenantRef: TENANT, now }), { generatedAt: now.toISOString(), run: null, latest: null, sites: [], contentRun: null, tenantSharing: null });

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
    // No content backup yet: nothing held and nobody known.
    assert.equal(data.sites[1].backup, null);
    assert.equal(data.sites[1].people, null);
    assert.equal(data.contentRun, null);

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

test("the loader joins each site's nightly backup: items, size, last stored, owners and groups, and the tenant's sharing", async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const now = new Date("2026-10-15T12:00:00.000Z");
    const financeRow = site(FINANCE, "Finance", []);
    Object.assign(financeRow.fields, { sharingCapability: "ExternalUserAndGuestSharing" });
    Object.assign(financeRow.fieldCoverage, { sharingCapability: observed("sharepoint.site-sharing") });
    const archiveRow = site(ARCHIVE, "Archive", []);
    Object.assign(archiveRow.fieldCoverage, { sharingCapability: { status: "unknown", operation: "sharepoint.site-sharing", reason: "not read yet: the per-site sharing read is not live-qualified" } });
    const result = run("2026-10-15T02:00:00.000Z", "complete", [financeRow, archiveRow]);
    result.tenant = { fields: { sharingCapability: "ExternalUserSharingOnly" }, fieldCoverage: { sharingCapability: { status: "observed", operation: "sharepoint.tenant-settings" } } } as never;
    await recordSharePointRun(client, { tenantRef: TENANT, result });
    const item = (container: string, itemKey: string, version: string, bytes: number, at: string, metadata: unknown = {}) => client.query(
      `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, created_at)
       VALUES ($1, 'sharepoint-sites', $2, $3, $4, $5, $6, $7, '[]'::jsonb, 'k1', $8)`,
      [TENANT, container, itemKey, version, metadata, "a".repeat(64), bytes, at],
    );
    const summary = { v: 1, inherits: false, groups: [{ name: "Finance Owners", members: 2, roles: ["Full Control"] }], owners: ["Amara Okafor", "Dev Patel"], ownerCount: 2, admins: 1, people: 7, guests: 1, sharingLinks: 2, directRoles: 0, uniqueLists: 1 };
    await item(`site:${FINANCE}`, "site", "v1", 1000, "2026-10-14T01:00:00Z");
    await item(`site:${FINANCE}`, "site", "v2", 1100, "2026-10-15T01:00:00Z");
    await item(`site:${FINANCE}`, "site/permissions", "p1", 500, "2026-10-14T01:00:00Z", { contentType: "application/json", summary: { ...summary, ownerCount: 0, owners: [] } });
    await item(`site:${FINANCE}`, "site/permissions", "p2", 500, "2026-10-15T01:02:00Z", { contentType: "application/json", summary });
    // Another workload's and another tenant's rows are not counted.
    await client.query(`INSERT INTO content_item (tenant_ref, workload, container, item_key, version, sha256, bytes, chunks, key_id) VALUES ($1, 'teams', $2, 'x', 'v', $3, 99, '[]'::jsonb, 'k1')`, [TENANT, `site:${FINANCE}`, "b".repeat(64)]);
    await client.query(`INSERT INTO content_item (tenant_ref, workload, container, item_key, version, sha256, bytes, chunks, key_id) VALUES ('other', 'sharepoint-sites', $1, 'x', 'v', $2, 99, '[]'::jsonb, 'k1')`, [`site:${ARCHIVE}`, "c".repeat(64)]);
    await client.query(
      `INSERT INTO content_run (tenant_ref, workload, outcome, items, bytes, reasons, name_prefix, started_at, completed_at)
       VALUES ($1, 'sharepoint-sites', 'partial', 4, 3100, $2, 'Fin', '2026-10-15T01:00:00Z', '2026-10-15T01:30:00Z')`,
      [TENANT, JSON.stringify(["Finance: 1 part(s) not fully read, first permissions: denied (403)"])],
    );

    const data = await loadSitePermissions(client, { tenantRef: TENANT, now });
    assert.equal(data.tenantSharing, "ExternalUserSharingOnly");
    assert.deepEqual(data.contentRun, { outcome: "partial", completedAt: "2026-10-15T01:30:00.000Z", namePrefix: "Fin", reasons: ["Finance: 1 part(s) not fully read, first permissions: denied (403)"] });
    const [archive, finance] = data.sites;
    // Each site's own sharing setting, compared with the tenant default it was read with.
    assert.deepEqual(finance.sharing, { status: "observed", value: "ExternalUserAndGuestSharing", tenant: "ExternalUserSharingOnly" });
    assert.equal(sharingStatus(finance).key, "wider");
    assert.deepEqual(archive.sharing, { status: "not-read", value: null, tenant: "ExternalUserSharingOnly" });
    assert.equal(archive.backup, null);
    assert.deepEqual(finance.backup, { items: 2, bytes: 3100, lastStoredAt: "2026-10-15T01:02:00.000Z" });
    // The newest summary wins.
    assert.equal(finance.people?.ownerCount, 2);
    assert.deepEqual(finance.people?.owners, ["Amara Okafor", "Dev Patel"]);
    assert.equal(finance.people?.readAt, "2026-10-15T01:02:00.000Z");
    // Outside the name filter: not backed up.
    assert.equal(backupStatus(archive, data.contentRun).key, "outside");
    assert.equal(backupStatus(finance, data.contentRun).key, "partial");

    const one = await loadSitePermissions(client, { tenantRef: TENANT, siteId: FINANCE, now });
    assert.deepEqual(one.sites.map((entry) => entry.siteId), [FINANCE]);
    assert.equal(one.sites[0].backup?.items, 2);
    assert.equal(one.tenantSharing, "ExternalUserSharingOnly");
  } finally {
    await client.end();
    await database.cleanup();
  }
});

const NOW = "2026-10-15T12:00:00.000Z";
const RUN = { id: "c0110000-0000-4000-8000-0000000000c1", outcome: "complete" as const, observedTo: "2026-10-15T02:00:00.000Z" };
const NIGHTLY: SitesContentRun = { outcome: "succeeded", completedAt: "2026-10-15T01:30:00.000Z", namePrefix: null, reasons: [] };
const PEOPLE: PeopleSummary = {
  inherits: false, groups: [{ name: "Finance Owners", members: 1, roles: ["Full Control"] }, { name: "Finance Members", members: 5, roles: ["Edit"] }],
  owners: ["Amara Okafor"], ownerCount: 1, people: 6, guests: 0, sharingLinks: 0, uniqueLists: 0, readAt: "2026-10-15T01:10:00.000Z",
};
const HELD = { items: 1200, bytes: 5 * 1024 * 1024, lastStoredAt: "2026-10-15T01:10:00.000Z" };
const FINANCE_SITE: SitePermissions = {
  ...sitePermissionsFrom(`site:${FINANCE}`, {
    displayName: "Finance", webUrl: `https://${HOST}/sites/finance`,
    appPermissionGrants: [
      { id: "g1", roles: ["fullcontrol"], applications: [{ id: PAYROLL_APP, displayName: "Payroll connector" }] },
      { id: "g2", roles: ["read"], applications: [{ id: "a0a00000-0000-4000-8000-0000000000a2", displayName: null }] },
    ],
  }, { appPermissionGrants: observed("sharepoint.site-permissions") }),
  backup: HELD, people: PEOPLE,
};
const QUIET: SitePermissions = {
  ...sitePermissionsFrom(`site:${ARCHIVE}`, { displayName: "Archive", appPermissionGrants: [] }, { appPermissionGrants: observed("x") }),
  backup: HELD, people: PEOPLE,
};

test("each site's backup, apps, owners and guests read as badges, problems first", () => {
  assert.equal(roleLabel("fullcontrol"), "Full control");
  assert.equal(roleLabel("Full Control"), "Full control");
  assert.equal(roleLabel("limitedAccess"), "Limited access");
  assert.deepEqual(backupStatus(QUIET, NIGHTLY), { key: "ok", label: "Backed up", tone: "fine", at: NIGHTLY.completedAt, detail: null });
  assert.equal(backupStatus({ ...QUIET, backup: null }, null).key, "none");
  assert.equal(backupStatus(QUIET, { ...NIGHTLY, outcome: "failed", reasons: ["site discovery: 500"] }).tone, "urgent");
  assert.equal(backupStatus(QUIET, { ...NIGHTLY, namePrefix: "KEEL-RT-" }).key, "outside");
  assert.equal(backupStatus({ ...QUIET, name: "keel-rt-archive" }, { ...NIGHTLY, namePrefix: "KEEL-RT-" }).key, "ok");

  assert.deepEqual(appStatus(QUIET), { key: "none", label: "No apps", tone: "fine", detail: "No app has been given access to this site." });
  assert.equal(appStatus(FINANCE_SITE).label, "2 apps, 1 full control");
  assert.equal(appStatus(FINANCE_SITE).tone, "soon");
  const denied = sitePermissionsFrom(`site:${ARCHIVE}`, { displayName: "Archive" }, { appPermissionGrants: { status: "denied", httpStatus: 403 } });
  assert.equal(appStatus(denied).key, "unknown");

  assert.equal(peopleStatus(QUIET, NIGHTLY).label, "1 owner");
  assert.equal(peopleStatus({ ...QUIET, people: { ...PEOPLE, owners: [], ownerCount: 0 } }, NIGHTLY).key, "no-owner");
  assert.equal(peopleStatus({ ...QUIET, people: null }, NIGHTLY).key, "pending");
  // A refused permissions read names the grant and links to where it is fixed.
  const refused = peopleStatus({ ...QUIET, people: null }, { ...NIGHTLY, reasons: ["Archive: 1 part(s) not fully read, first permissions: denied (403)"] });
  assert.equal(refused.key, "denied");
  assert.match(refused.detail ?? "", /Sites\.FullControl\.All/);
  assert.deepEqual(refused.fix, { label: "Check app permissions", href: "/setup" });

  assert.equal(externalStatus({ ...QUIET, people: null }), null);
  assert.equal(externalStatus(QUIET)?.label, "No guests");
  assert.equal(externalStatus({ ...QUIET, people: { ...PEOPLE, guests: 2, sharingLinks: 1 } })?.label, "2 guests");
  assert.equal(externalStatus({ ...QUIET, people: { ...PEOPLE, sharingLinks: 3 } })?.label, "3 sharing links");
  assert.equal(tenantSharingWords("ExternalUserSharingOnly"), "Guests who sign in");

  // Problems first: no owner, then not backed up / full-control apps, then the quiet ones.
  const orphan = { ...QUIET, siteId: "o", displayName: "Zeta", people: { ...PEOPLE, ownerCount: 0, owners: [] } };
  assert.deepEqual(sitesInOrder([QUIET, FINANCE_SITE, orphan], NIGHTLY).map((entry) => entry.displayName), ["Zeta", "Finance", "Archive"]);
  const tile = (key: string) => SITE_TILES.find((entry) => entry.key === key)!;
  assert.ok(tile("no-owner").test(orphan, NIGHTLY));
  assert.ok(tile("apps").test(FINANCE_SITE, NIGHTLY));
  assert.ok(!tile("attention").test(QUIET, NIGHTLY));
});

test("the verdicts lead with problems and are green only when nothing needs a person", () => {
  const base: SitePermissionsData = { generatedAt: NOW, run: null, latest: null, sites: [] };
  assert.deepEqual(sitesVerdict(base), { text: "KEEL has not read your SharePoint sites yet.", tone: "attention" });
  assert.equal(sitesVerdict({ ...base, latest: { ...RUN, outcome: "disabled" } }).tone, "attention");
  assert.equal(sitesVerdict({ ...base, latest: { ...RUN, outcome: "failed" } }).tone, "critical");
  const good = { ...base, run: RUN, sites: [QUIET, FINANCE_SITE], contentRun: NIGHTLY };
  assert.deepEqual(sitesVerdict(good), { text: "All 2 sites are backed up and owned; 1 has apps with access.", tone: "good" });
  assert.deepEqual(sitesVerdict({ ...good, contentRun: { ...NIGHTLY, namePrefix: "KEEL-RT-" } }), { text: "2 sites are not backed up.", tone: "attention" });
  const orphan = { ...QUIET, people: { ...PEOPLE, ownerCount: 0, owners: [] } };
  assert.equal(sitesVerdict({ ...good, sites: [orphan] }).text, "1 site has no owner.");
  assert.equal(sitesVerdict({ ...good, sites: [orphan] }).tone, "critical");
  assert.equal(sitesVerdict({ ...good, contentRun: { ...NIGHTLY, outcome: "failed" } }).tone, "critical");
  assert.equal(sitesVerdict({ ...good, run: { ...RUN, capped: true } }).tone, "attention");

  assert.deepEqual(siteVerdict(QUIET, NIGHTLY), { text: "Backed up and owned, with no guests and no apps. Nothing needs you here.", tone: "good" });
  assert.deepEqual(siteVerdict(FINANCE_SITE, NIGHTLY), { text: "1 app has full control.", tone: "attention" });
  assert.equal(siteVerdict({ ...QUIET, people: null }, NIGHTLY).tone, "attention");
  assert.equal(siteVerdict(orphan, NIGHTLY).tone, "critical");
  for (const data of [base, good]) assert.ok(sitesVerdict(data).text.split(/\s+/).length <= 25);
});

test("the list is a table that links each site; a site's page shows status tiles and compact tables, ids only in Technical details", () => {
  const data: SitePermissionsData = { generatedAt: NOW, run: RUN, latest: null, sites: [FINANCE_SITE, QUIET], contentRun: NIGHTLY, tenantSharing: "ExternalUserSharingOnly" };
  const list = renderToStaticMarkup(createElement(SiteList, { data }));
  assert.match(list, /<table[^>]*aria-label="Sites"/);
  assert.ok(list.includes(`href="/sites/${HOST}%2C11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222"`));
  assert.match(list, /Backed up/);
  assert.match(list, /1,200 items · 5\.0 MB/);
  assert.match(list, /Amara Okafor/);
  assert.match(list, /Guests who sign in/);
  assert.doesNotMatch(list, /not read yet/);

  const detail = renderToStaticMarkup(createElement(SiteDetail, { site: FINANCE_SITE, run: RUN, latest: null, now: NOW, contentRun: NIGHTLY, tenantSharing: null }));
  for (const tile of ["Backup", "Apps with access", "Sharing setting", "Guests and links", "Owners"]) assert.match(detail, new RegExp(`st-status-label[^>]*>.*?${tile}`));
  assert.match(detail, /Payroll connector/);
  assert.match(detail, /Full control/);
  assert.match(detail, /An app with no name/);
  assert.match(detail, /Finance Members/);
  // No empty panels: a site with no apps has no apps table.
  const quiet = renderToStaticMarkup(createElement(SiteDetail, { site: QUIET, run: RUN, latest: null, now: NOW, contentRun: NIGHTLY }));
  assert.doesNotMatch(quiet, /site-apps-heading/);
  assert.doesNotMatch(quiet, /No app grants on this site/);
  // Every id is inside a record (Technical details) block.
  const outside = detail.replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(outside, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.match(detail, new RegExp(PAYROLL_APP));

  const refused = renderToStaticMarkup(createElement(SiteDetail, {
    site: { ...QUIET, people: null }, run: RUN, latest: { ...RUN, id: "n", outcome: "failed" }, now: NOW,
    contentRun: { ...NIGHTLY, outcome: "partial", reasons: ["Archive: 1 part(s) not fully read, first permissions: denied (HTTP 403)"] },
  }));
  assert.match(refused, /Not allowed/);
  assert.match(refused, /href="\/setup"/);
  assert.match(refused, /Show the error/);
  assert.match(refused, /The newest SharePoint read failed 10 hours ago/);
});

const withSharing = (base: SitePermissions, value: string | null, tenant: string | null, status: SitePermissions["sharing"]["status"] = value ? "observed" : "not-read"): SitePermissions => ({
  ...base, sharing: { status, value, tenant },
});

test("each site's own sharing setting reads against the tenant default; more open than the default is urgent and sorts first", () => {
  const tenant = "ExternalUserSharingOnly";
  const wider = withSharing(QUIET, "ExternalUserAndGuestSharing", tenant);
  assert.equal(sharingStatus(wider).key, "wider");
  assert.equal(sharingStatus(wider).tone, "urgent");
  assert.equal(sharingStatus(wider).label, "Anyone with the link");
  assert.match(sharingStatus(wider).detail ?? "", /More open than your organisation's default \(Guests who sign in\)/);
  // Case does not matter: Graph says externalUserSharingOnly, PnP ExternalUserSharingOnly.
  assert.equal(sharingStatus(withSharing(QUIET, "ExternalUserSharingOnly", "externalUserSharingOnly")).key, "guests");
  assert.match(sharingStatus(withSharing(QUIET, "ExternalUserSharingOnly", tenant)).detail ?? "", /Same as your organisation's default/);
  const stricter = sharingStatus(withSharing(QUIET, "Disabled", tenant));
  assert.deepEqual([stricter.key, stricter.tone, stricter.label], ["internal", "fine", "Organisation only"]);
  assert.match(stricter.detail ?? "", /Stricter than your organisation's default/);
  // Anyone-links are worth a look even when the tenant allows them.
  assert.equal(sharingStatus(withSharing(QUIET, "ExternalUserAndGuestSharing", "ExternalUserAndGuestSharing")).tone, "soon");
  // Not read yet is neutral, never a guessed value; a refused read says so.
  assert.deepEqual([sharingStatus(QUIET).key, sharingStatus(QUIET).tone], ["not-read", "neutral"]);
  assert.equal(sharingStatus(withSharing(QUIET, null, tenant, "denied")).label, "Not allowed");
  // Approved but the host has no PnP config: says so, instead of "not approved yet".
  const unconfigured = sitePermissionsFrom(`site:${ARCHIVE}`, { displayName: "Archive" }, { sharingCapability: { status: "unknown", operation: "sharepoint.site-sharing", reason: "not read: the scope file names no PnP config for SharePoint (powershellConfigs.sharepoint)" } });
  assert.deepEqual([sharingStatus(unconfigured).label, sharingStatus(unconfigured).tone], ["Not set up", "soon"]);
  // Unknown tenant default: shown, but never called wider.
  assert.equal(sharingStatus(withSharing(QUIET, "ExternalUserAndGuestSharing", null)).key, "anyone");

  const named = { ...wider, siteId: "w", displayName: "Wider" };
  assert.deepEqual(sitesInOrder([QUIET, named], NIGHTLY).map((entry) => entry.displayName), ["Wider", "Archive"]);
  const tile = SITE_TILES.find((entry) => entry.key === "wider")!;
  assert.ok(tile.test(named));
  assert.ok(!tile.test(QUIET));
  const data: SitePermissionsData = { generatedAt: NOW, run: RUN, latest: null, sites: [QUIET, named], contentRun: NIGHTLY, tenantSharing: tenant };
  assert.deepEqual(sitesVerdict(data), { text: "1 site is shared more widely than your organisation's default.", tone: "critical" });
  assert.equal(siteVerdict(named, NIGHTLY).tone, "critical");

  const list = renderToStaticMarkup(createElement(SiteList, { data }));
  assert.match(list, /Sharing setting/);
  assert.match(list, /Anyone with the link/);
  assert.match(list, /More open than the default/);
  assert.match(list, /Shared wider than default/);
  const detail = renderToStaticMarkup(createElement(SiteDetail, { site: named, run: RUN, latest: null, now: NOW, contentRun: NIGHTLY, tenantSharing: tenant }));
  assert.match(detail, /Organisation default: Guests who sign in/);
  assert.match(detail, /data-tone="urgent"[^>]*>\s*<span class="st-status-label">.*?Sharing setting/);
});
