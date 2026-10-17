import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { recordSharePointRun } from "../../engine/collect/workloads/sharepoint.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { AlertInbox } from "@/components/alert-inbox";
import { alertResourceNames } from "@/lib/alerts";
import { alertTitle, type AlertItem } from "@/lib/alerts-view";

// The Alerts page names what each alert is about, never by the Graph object id or the
// SharePoint site id its key holds. Keys stay in Technical details.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "alert-names-test";
const HOST = "contoso.sharepoint.com";
const FINANCE = `${HOST},11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222`;
const NAMELESS_SITE = `${HOST},33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444`;
const SCRIPT_ID = "5b1c2d3e-0000-4000-8000-00000000c0de";
const NAMELESS_ID = "9a8b7c6d-0000-4000-8000-0000000000ff";
const SITE_KEY = `sharepoint-site-settings:site:${FINANCE}`;
const NAMELESS_SITE_KEY = `sharepoint-site-settings:site:${NAMELESS_SITE}`;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

const observed = (operation: string) => ({ status: "observed", operation });
const site = (siteId: string, displayName: string | null) => ({
  siteId,
  fields: displayName ? { displayName, appPermissionGrants: [] } : { appPermissionGrants: [] },
  fieldCoverage: { displayName: observed("sharepoint.site-properties"), appPermissionGrants: observed("sharepoint.site-permissions") },
});
const run = (at: string, sites: ReturnType<typeof site>[]) => ({
  workload: "sharepoint-site-settings", tenantHost: HOST, outcome: "complete", observedFrom: at, observedTo: at, sites,
  tenant: { fields: {}, fieldCoverage: {} }, discovery: null, fieldCounts: {}, outOfScope: [],
});

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  client = await database.connect();
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id",
    [TENANT, "2026-10-02T06:00:00Z"],
  );
  for (const [key, type, payload] of [
    [SCRIPT_ID, "deviceManagementScript", { id: SCRIPT_ID, displayName: "Set time zone" }],
    [NAMELESS_ID, "oauth2PermissionGrant", { id: NAMELESS_ID, scope: "User.Read" }],
  ] as const) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [snapshot.id, key, type, JSON.stringify(payload), JSON.stringify(payload)],
    );
  }
  // Finance is renamed in the newer read; another tenant names the same site otherwise.
  await recordSharePointRun(client, { tenantRef: TENANT, result: run("2026-10-13T02:00:00.000Z", [site(FINANCE, "Finance"), site(NAMELESS_SITE, null)]) });
  await recordSharePointRun(client, { tenantRef: TENANT, result: run("2026-10-14T02:00:00.000Z", [site(FINANCE, "Finance team"), site(NAMELESS_SITE, null)]) });
  await recordSharePointRun(client, { tenantRef: "someone-else", result: run("2026-10-15T02:00:00.000Z", [site(FINANCE, "Elsewhere")]) });
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("each alerted resource reads the newest name this tenant's backups and site reads hold", async () => {
  const names = await alertResourceNames(client, TENANT, [SITE_KEY, NAMELESS_SITE_KEY, SCRIPT_ID, NAMELESS_ID, "sharepoint-site-settings:tenant", SITE_KEY]);
  assert.equal(names.get(SITE_KEY), "Finance team");
  assert.equal(names.get(SCRIPT_ID), "Set time zone");
  assert.equal(names.has(NAMELESS_SITE_KEY), false);
  assert.equal(names.has(NAMELESS_ID), false);
  assert.equal(names.has("sharepoint-site-settings:tenant"), false);
});

test("a failed name lookup leaves the alerts unnamed instead of breaking the page", async () => {
  const broken = { query: async () => { throw new Error("database down"); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await alertResourceNames(broken, TENANT, [SITE_KEY, SCRIPT_ID])).size, 0);
  } finally {
    console.error = quiet;
  }
});

test("alert titles are names, never ids", () => {
  const title = (resourceKey: string, name: string | null, resourceType: string | null = null) =>
    alertTitle({ resourceKey, name, cause: { changeType: "modified", resourceType, snapshotId: null } });
  assert.equal(title(SITE_KEY, "Finance team", "sharepoint-site-settings"), "Finance team (SharePoint site)");
  assert.equal(title(NAMELESS_SITE_KEY, null, "sharepoint-site-settings"), "Unnamed SharePoint site");
  assert.equal(title("sharepoint-site-settings:tenant", null, "sharepoint-site-settings"), "SharePoint sharing settings");
  assert.equal(title("exchange-mailbox-settings:mailbox:finance@contoso.com", null), "mailbox · finance@contoso.com (Mailbox settings)");
  assert.match(title(SCRIPT_ID, "Set time zone", "deviceManagementScript"), /^Set time zone \(/);
  assert.match(title(NAMELESS_ID, null, "oauth2PermissionGrant"), /^Unnamed /);
  assert.equal(title("group:Finance", null), "Finance (group)");
  assert.equal(title("group:Finance", "Finance staff"), "Finance staff (group)");
  assert.equal(title("user:bg1@contoso.onmicrosoft.com", null), "bg1@contoso.onmicrosoft.com (user)");
  assert.match(title(`roleAssignment:unknown:${SCRIPT_ID}@x@/`, null, "roleAssignment"), /^Unnamed /);
  assert.equal(title(SCRIPT_ID, NAMELESS_ID, "deviceManagementScript").search(GUID), -1, "a name that is itself an id is not used");
});

const alert = (over: Partial<AlertItem>): AlertItem => ({
  id: "a1e70000-0000-4000-8000-000000000001", resourceKey: SITE_KEY, name: "Finance team", control: "baseline", condition: "drift",
  state: "open", conditionActive: true, severity: "warning", occurrence: 1, firstOpenedAt: "2026-10-14T02:00:00Z",
  occurrenceStartedAt: "2026-10-14T02:00:00Z", lastFiringAt: "2026-10-14T02:00:00Z", ackDeadlineAt: null,
  acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: "modified", resourceType: "sharepoint-site-settings", snapshotId: null },
  lastEventId: "workload-drift:1", history: [], ...over,
});

test("the inbox shows names in its headings and keeps the keys in Technical details", () => {
  const html = renderToStaticMarkup(createElement(AlertInbox, {
    alerts: [
      alert({}),
      alert({ id: "a1e70000-0000-4000-8000-000000000002", resourceKey: NAMELESS_ID, name: null, cause: { changeType: "removed", resourceType: "oauth2PermissionGrant", snapshotId: null } }),
    ],
    now: "2026-10-15T12:00:00Z",
    canRespond: true,
  }));
  const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);
  assert.ok(headings.includes("Finance team (SharePoint site)"));
  assert.ok(headings.includes("Resolve the alert for Finance team (SharePoint site)?"), "the resolve dialog names it too");
  assert.ok(headings.some((heading) => heading.startsWith("Unnamed ")));
  for (const heading of headings) assert.doesNotMatch(heading, GUID);
  assert.ok(html.includes(SITE_KEY), "the stored key stays available under Technical details");
});
