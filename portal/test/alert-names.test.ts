import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { recordSharePointRun } from "../../engine/collect/workloads/sharepoint.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { alertObjects, alertResourceNames } from "@/lib/alerts";
import { deletedSinceWords, splitObjectTitle } from "@/lib/object-label";
import { alertTitle, causeSentence, type AlertItem } from "@/lib/alerts-view";
import { renderAlertsAt } from "./render-alerts";

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
const OLD_TEAM_ID = "0f1a0000-0000-4000-8000-000000000002";
const SALES_ID = "0f1a0000-0000-4000-8000-000000000003";
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
  // Old project team is in the first backup only; the next complete backup that read
  // groups no longer holds it, so it is deleted since that backup.
  for (const [at, groups] of [["2026-10-01T06:00:00Z", ["Old project team", "Sales"]], ["2026-10-03T06:00:00Z", ["Sales"]]] as const) {
    const { rows: [backup] } = await client.query(
      "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id", [TENANT, at]);
    for (const name of groups) {
      const payload = { id: name === "Sales" ? SALES_ID : OLD_TEAM_ID, displayName: name };
      await client.query(
        `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
         VALUES ($1, $2, 'group', $3, $4, 'critical', 'access-affecting', 'full', '{}')`,
        [backup.id, `group:${name}`, JSON.stringify(payload), JSON.stringify(payload)],
      );
    }
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

test("the list shows names in its rows and keeps the keys in Technical details", async () => {
  const html = await renderAlertsAt("", {
    alerts: [
      alert({}),
      alert({ id: "a1e70000-0000-4000-8000-000000000002", resourceKey: NAMELESS_ID, name: null, cause: { changeType: "removed", resourceType: "oauth2PermissionGrant", snapshotId: null } }),
    ],
    now: "2026-10-15T12:00:00Z",
    canRespond: true,
    canMute: false,
  });
  const names = [...html.matchAll(/class="al-row-link"[^>]*>(.*?)<\/a>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
  assert.ok(names.includes("Finance team (SharePoint site)"));
  assert.ok(names.some((name) => name.startsWith("Unnamed ")));
  for (const name of names) assert.doesNotMatch(name, GUID);
  assert.ok(html.includes(SITE_KEY), "the stored key stays available under Technical details");
});

test("SharePoint alerts say what differs from the approved setup, never a baseline", () => {
  assert.equal(causeSentence(alert({})), "Its settings differ from the approved setup.");
  assert.equal(causeSentence(alert({ cause: { changeType: "added", resourceType: "sharepoint-site-settings", snapshotId: null } })), "It is new since the approved setup.");
  assert.equal(causeSentence(alert({ cause: { changeType: "removed", resourceType: "sharepoint-site-settings", snapshotId: null } })), "It was missing from the latest read.");
  assert.equal(causeSentence(alert({ resourceKey: "sharepoint-site-settings:tenant", name: null })), "Its settings differ from the approved setup.");
  assert.doesNotMatch(causeSentence(alert({ conditionActive: false })), /baseline/);
  const backup = alert({ resourceKey: "group:Finance", name: null, cause: { changeType: "modified", resourceType: "group", snapshotId: null } });
  assert.equal(causeSentence(backup), "It differs from the approved setup.", "configuration drift is told against the approved setup");
  assert.equal(causeSentence({ ...backup, conditionActive: false }), "It matches the approved setup again.");
});

test("each backup key says whether the newest backup still holds it, and since when it is gone", async () => {
  const objects = await alertObjects(client, TENANT, ["group:Old project team", "group:Sales", "group:Never seen", SCRIPT_ID, SITE_KEY]);
  assert.deepEqual(objects.get("group:Old project team"), {
    status: "deleted", deletedSince: "2026-10-03T06:00:00.000Z", lastSeenAt: "2026-10-01T06:00:00.000Z", objectId: OLD_TEAM_ID, name: "Old project team",
  });
  assert.equal(objects.get("group:Sales")?.status, "found");
  assert.equal(objects.get("group:Never seen")?.status, "unknown");
  assert.equal(objects.get(SCRIPT_ID)?.name, "Set time zone");
  assert.equal(objects.has(SITE_KEY), false, "service settings are not in backups");
  const broken = { query: async () => { throw new Error("database down"); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await alertObjects(broken, TENANT, ["group:Sales"])).size, 0);
  } finally {
    console.error = quiet;
  }
});

test("a deleted object shows a dated badge beside its name, and its id only in Technical details", async () => {
  const html = await renderAlertsAt("", {
    alerts: [alert({
      resourceKey: "group:Old project team", name: "Old project team",
      object: { status: "deleted", deletedSince: "2026-10-03T06:00:00.000Z", lastSeenAt: "2026-10-01T06:00:00.000Z", objectId: OLD_TEAM_ID },
      cause: { changeType: "removed", resourceType: "group", snapshotId: null },
    })],
    now: "2026-10-15T12:00:00Z",
    canRespond: true,
    canMute: false,
  });
  assert.match(html, /class="al-row-link"[^>]*><span class="object-label"><span class="object-label-name">Old project team<\/span><span class="object-label-type"> \(group\)<\/span>/);
  assert.ok(html.includes("Deleted since 3 Oct 2026"));
  const record = html.indexOf('data-layer="record"');
  assert.ok(record > 0, "the alerts carry Technical details");
  const text = html.slice(0, record).replace(/<[^>]+>/g, " ");
  assert.equal(text.search(GUID), -1, "no id shows as text before Technical details");
});

test("object titles split into name and kind and read back the same", () => {
  assert.deepEqual(splitObjectTitle("Finance (group)"), { name: "Finance", type: "group" });
  assert.deepEqual(splitObjectTitle("Sales (EU) (group)"), { name: "Sales (EU)", type: "group" });
  assert.deepEqual(splitObjectTitle("Unnamed SharePoint site"), { name: null, type: "SharePoint site" });
  assert.deepEqual(splitObjectTitle("SharePoint sharing settings"), { name: "SharePoint sharing settings", type: null });
  assert.equal(deletedSinceWords("2026-10-03T23:30:00Z"), "Deleted since 3 Oct 2026");
  assert.equal(deletedSinceWords(null), "Deleted");
});
